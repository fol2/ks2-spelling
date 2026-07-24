import argparse
import json
import re
import wave
from pathlib import Path

from piper import PiperVoice, SynthesisConfig


SAFE_WAV_PATH = re.compile(
    r"^audio/(?:iapetus|sulafat)/[a-z0-9-]+/"
    r"(?:word|sentence-[0-9]{2}-(?:normal|slow))\.wav$"
)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def load_jobs(path):
    jobs = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(jobs, list) or not jobs or len(jobs) > 420:
        raise ValueError("Starter audio jobs must be a bounded non-empty list.")
    seen = set()
    for job in jobs:
        if not isinstance(job, dict) or set(job) != {"input", "path", "lengthScale"}:
            raise ValueError("Starter audio job shape is invalid.")
        if (
            not isinstance(job["input"], str)
            or not job["input"].strip()
            or len(job["input"]) > 512
            or not isinstance(job["path"], str)
            or not SAFE_WAV_PATH.fullmatch(job["path"])
            or job["path"] in seen
            or job["lengthScale"] not in (1, 1.35)
        ):
            raise ValueError("Starter audio job authority is invalid.")
        seen.add(job["path"])
    return jobs


def main():
    arguments = parse_arguments()
    jobs = load_jobs(arguments.jobs)
    output_root = Path(arguments.output).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    voice = PiperVoice.load(arguments.model, config_path=arguments.config)

    for job in jobs:
        target = (output_root / job["path"]).resolve()
        if not target.is_relative_to(output_root) or target.exists():
            raise ValueError("Starter audio output path is unsafe or already exists.")
        target.parent.mkdir(parents=True, exist_ok=True)
        synthesis = SynthesisConfig(
            length_scale=job["lengthScale"],
            noise_scale=0,
            noise_w_scale=0,
            normalize_audio=True,
            volume=1,
        )
        try:
            with target.open("xb") as raw_file:
                with wave.open(raw_file, "wb") as wav_file:
                    voice.synthesize_wav(
                        job["input"],
                        wav_file,
                        syn_config=synthesis,
                    )
        except Exception:
            target.unlink(missing_ok=True)
            raise

    print(f"Generated {len(jobs)} Starter audio WAV authorities.")


if __name__ == "__main__":
    main()
