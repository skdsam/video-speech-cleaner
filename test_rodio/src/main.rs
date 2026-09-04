use std::fs::File;
use std::io::BufReader;
use std::time::Duration;
use rodio::{Decoder, OutputStream, Sink, Source};

fn main() {
    println!("Testing rodio...");
    let res = OutputStream::try_default();
    match res {
        Ok((_stream, stream_handle)) => {
            println!("Got output stream!");
            match Sink::try_new(&stream_handle) {
                Ok(sink) => {
                    println!("Got sink!");
                    let path = r"D:\scratch\Remove words\cache\current_preview.wav";
                    match File::open(path) {
                        Ok(file) => {
                            let reader = BufReader::new(file);
                            match Decoder::new(reader) {
                                Ok(source) => {
                                    println!("Decoder created!");
                                    let start = Duration::from_secs_f64(3.95);
                                    let dur = Duration::from_secs_f64(0.3);
                                    let sliced = source.skip_duration(start).take_duration(dur);
                                    sink.append(sliced);
                                    sink.play();
                                    println!("Playing snippet...");
                                    sink.sleep_until_end();
                                    println!("Playback complete!");
                                }
                                Err(e) => println!("Decoder error: {}", e),
                            }
                        }
                        Err(e) => println!("File open error: {}", e),
                    }
                }
                Err(e) => println!("Sink error: {}", e),
            }
        }
        Err(e) => println!("OutputStream error: {}", e),
    }
}

