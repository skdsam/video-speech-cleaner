use serde::Deserialize;

#[derive(Deserialize)]
struct Expected {
    start_seconds: f64,
    end_seconds: f64,
}

#[derive(Deserialize)]
struct GroundTruth {
    expected_fillers: Vec<Expected>,
}

#[test]
#[ignore = "requires local Whisper model and FFmpeg; runs real speech recognition"]
fn finds_all_five_known_fillers_and_covers_their_audio() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let truth: GroundTruth = serde_json::from_str(
        &std::fs::read_to_string(workspace.join("Speech_Cleaner_Test_Ground_Truth.json")).unwrap(),
    )
    .unwrap();
    let result = speech_cleaner_app_lib::analyze_file(
        workspace
            .join("Speech_Cleaner_Test.mp4")
            .to_string_lossy()
            .into_owned(),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(result.fillers.len(), truth.expected_fillers.len());
    let mut reader = hound::WavReader::open(&result.audio_preview_path).unwrap();
    let spec = reader.spec();
    let samples: Vec<f64> = reader.samples::<i16>().map(|s| s.unwrap() as f64).collect();
    let energy = |start: f64, end: f64| {
        let scale = spec.sample_rate as f64 * spec.channels as f64;
        samples[(start * scale) as usize..((end * scale) as usize).min(samples.len())]
            .iter()
            .map(|s| s * s)
            .sum::<f64>()
    };
    for (found, expected) in result.fillers.iter().zip(&truth.expected_fillers) {
        assert!(found.enabled, "{} should have usable timing", found.word);
        assert!((found.start - expected.start_seconds).abs() <= 0.08);
        assert!(found.end <= expected.end_seconds + 0.08);
        // The fixture's labels include about 450 ms of trailing silence. Check
        // sound coverage rather than forcing the mute to include that silence.
        let total = energy(expected.start_seconds, expected.end_seconds);
        let covered = energy(
            found.start.max(expected.start_seconds),
            found.end.min(expected.end_seconds),
        );
        assert!(
            covered / total > 0.98,
            "{} covers only {:.1}% of filler energy",
            found.word,
            100.0 * covered / total
        );
    }
}
