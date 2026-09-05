//! Match complete words, not Whisper's subword vocabulary (e.g. z + er + d).
use crate::{FillerItem, WhisperOutput};

fn is_filler(word: &str) -> bool {
    let mut collapsed = String::new();
    for c in word.chars() {
        if !collapsed.ends_with(c) {
            collapsed.push(c);
        }
    }
    matches!(collapsed.as_str(), "um" | "uh" | "erm" | "er" | "ah" | "hm")
}

pub fn detect_fillers(output: &WhisperOutput, duration: f64) -> Vec<FillerItem> {
    let mut result = Vec::new();
    for segment in &output.transcription {
        // Reassemble the token stream first: a word can span several tokens,
        // and one token can contain punctuation or several words.
        let mut text = String::new();
        let mut spans = Vec::new();
        for token in &segment.tokens {
            if token.text.starts_with("[_") {
                continue;
            }
            let from = text.len();
            text.push_str(&token.text);
            spans.push((from, text.len(), token));
        }
        if text.trim().is_empty() {
            text = segment.text.clone();
        }
        let words: Vec<_> = text
            .match_indices(|c: char| c.is_alphabetic() || c == '\'')
            .collect();
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for (offset, letter) in words {
            if let Some(last) = runs.last_mut() {
                if last.1 == offset {
                    last.1 += letter.len();
                    continue;
                }
            }
            runs.push((offset, offset + letter.len()));
        }
        for (index, &(from, to)) in runs.iter().enumerate() {
            let word = text[from..to].to_lowercase();
            if !is_filler(&word) {
                continue;
            }
            let tokens: Vec<_> = spans
                .iter()
                .filter(|(a, b, _)| *a < to && *b > from)
                .map(|(_, _, t)| *t)
                .collect();
            let valid: Vec<_> = tokens
                .iter()
                .filter(|t| t.offsets.from >= 0 && t.offsets.to >= t.offsets.from)
                .collect();
            let measured = !valid.is_empty();
            let (start, end, confidence) = if measured {
                (
                    valid.iter().map(|t| t.offsets.from).min().unwrap() as f64 / 1000.0,
                    valid.iter().map(|t| t.offsets.to).max().unwrap() as f64 / 1000.0,
                    tokens.iter().map(|t| t.p).sum::<f64>() / tokens.len() as f64,
                )
            } else {
                // Keep untimed candidates visible for review, but never silently
                // mute ordinary speech using guessed, evenly distributed timings.
                let a = segment.offsets.from.max(0) as f64 / 1000.0;
                let b = segment.offsets.to.max(0) as f64 / 1000.0;
                let start = a + (b - a).max(0.0) * index as f64 / runs.len().max(1) as f64;
                (start, (start + 0.4).min(b), 0.0)
            };
            let start = start.clamp(0.0, duration);
            let timed_interval = end > start;
            let end = if measured && !timed_interval {
                start + 0.15
            } else {
                end
            }
            .clamp(0.0, duration);
            if end <= start {
                continue;
            }
            result.push(FillerItem {
                id: String::new(),
                word,
                start,
                end,
                confidence: confidence.clamp(0.0, 1.0),
                enabled: measured && timed_interval,
                timing_estimated: !measured || !timed_interval,
            });
        }
    }
    result.sort_by(|a, b| a.start.total_cmp(&b.start));
    for (i, item) in result.iter_mut().enumerate() {
        item.id = format!("filler_{}", i + 1);
    }
    result
}

/// Refine only nearby, isolated speech islands using 10 ms audio frames. The
/// display waveform has over a second per point on a 42-minute video and must
/// never be used to position mutes. Long continuous speech is left untouched.
pub fn refine_timestamps(
    items: &mut [FillerItem],
    wav: &std::path::Path,
    duration: f64,
) -> Result<(), String> {
    let mut reader = hound::WavReader::open(wav).map_err(|e| e.to_string())?;
    let frame_samples = (reader.spec().sample_rate / 100).max(1) as usize;
    let mut envelope = Vec::new();
    let mut peak = 0.0_f32;
    let mut count = 0;
    for sample in reader.samples::<i16>() {
        peak = peak.max(sample.map_err(|e| e.to_string())?.unsigned_abs() as f32 / 32768.0);
        count += 1;
        if count == frame_samples {
            envelope.push(peak);
            peak = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        envelope.push(peak);
    }
    refine_with_envelope(items, &envelope, duration);
    Ok(())
}

fn refine_with_envelope(items: &mut [FillerItem], envelope: &[f32], duration: f64) {
    let threshold = (envelope.iter().copied().fold(0.0_f32, f32::max) * 0.06).max(0.005);
    let mut islands: Vec<(f64, f64)> = Vec::new();
    for (i, &peak) in envelope.iter().enumerate() {
        if peak < threshold {
            continue;
        }
        let start = i as f64 * 0.01;
        if let Some(last) = islands.last_mut() {
            if start - last.1 < 0.05 {
                last.1 = ((i + 1) as f64 * 0.01).min(duration);
                continue;
            }
        }
        islands.push((start, ((i + 1) as f64 * 0.01).min(duration)));
    }
    for item in items {
        // A zero-confidence candidate has only a guessed segment position.
        if item.confidence <= 0.0 {
            continue;
        }
        let midpoint = (item.start + item.end) / 2.0;
        if let Some(&(start, end)) = islands.iter().find(|&&(a, b)| {
            a <= midpoint
                && midpoint <= b
                && b - a <= 1.2
                && a >= item.start - 0.2
                && b <= item.end + 0.9
        }) {
            item.start = start;
            item.end = end;
            item.enabled = true;
            item.timing_estimated = false;
        }
        item.start = (item.start * 1000.0).round() / 1000.0;
        item.end = (item.end * 1000.0).round() / 1000.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(tokens: &[(&str, i64, i64)]) -> WhisperOutput {
        serde_json::from_value(json!({"transcription": [{
            "text": tokens.iter().map(|t| t.0).collect::<String>(),
            "offsets": {"from": 0, "to": 10000},
            "tokens": tokens.iter().map(|(text, from, to)| json!({
                "text": text, "p": 0.9, "offsets": {"from": from, "to": to}
            })).collect::<Vec<_>>()
        }]}))
        .unwrap()
    }

    #[test]
    fn ignores_fragments_in_ordinary_words() {
        let output = parse(&[
            (" z", 0, 100),
            ("er", 100, 200),
            ("d", 200, 300),
            (" um", 400, 500),
            ("brella", 500, 800),
            (" err", 900, 1000),
            ("or", 1000, 1100),
        ]);
        assert!(detect_fillers(&output, 10.0).is_empty());
    }

    #[test]
    fn finds_every_repetition_and_reassembles_elongated_fillers() {
        let output = parse(&[
            (" Um", 100, 300),
            (", er", 500, 600),
            ("m", 600, 800),
            (", um", 900, 1000),
            ("mmm", 1000, 1300),
            ("! errrr", 1500, 1800),
            (";uhhh", 1900, 2100),
            (" um", 2300, 2500),
        ]);
        let found = detect_fillers(&output, 10.0);
        assert_eq!(
            found.iter().map(|f| f.word.as_str()).collect::<Vec<_>>(),
            ["um", "erm", "ummmm", "errrr", "uhhh", "um"]
        );
        assert_eq!((found[1].start, found[1].end), (0.5, 0.8));
        assert_ne!(found[0].id, found[5].id);
    }

    #[test]
    fn retains_untimed_candidates_without_enabling_guessed_mutes() {
        let output = parse(&[(" Um", 100, 300), (", uh", -1, -1)]);
        let found = detect_fillers(&output, 10.0);
        assert_eq!(found.len(), 2);
        assert!(found[0].enabled);
        assert!(!found[1].enabled);
        assert!(found[1].timing_estimated);
        assert_eq!(found[1].confidence, 0.0);
    }

    #[test]
    fn clips_to_media_and_ignores_special_tokens() {
        let output = parse(&[("[_BEG_]", 0, 0), (" Um", 100, 300), (" uh", 2000, 3000)]);
        let found = detect_fillers(&output, 0.2);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].end, 0.2);
    }

    #[test]
    fn recovers_full_isolated_sound_without_jumping_across_silence() {
        let mut envelope = vec![0.0; 400];
        envelope[100..180].fill(0.5);
        envelope[250..300].fill(0.5);
        let mut found = detect_fillers(&parse(&[(" Um", 1020, 1300), (" er", 1900, 2000)]), 4.0);
        refine_with_envelope(&mut found, &envelope, 4.0);
        assert_eq!((found[0].start, found[0].end), (1.0, 1.8));
        assert_eq!((found[1].start, found[1].end), (1.9, 2.0));
    }

    #[test]
    fn does_not_expand_filler_to_a_continuous_sentence() {
        let mut found = detect_fillers(&parse(&[(" uh", 1500, 1700)]), 4.0);
        refine_with_envelope(&mut found, &vec![0.5; 400], 4.0);
        assert_eq!((found[0].start, found[0].end), (1.5, 1.7));
    }
}
