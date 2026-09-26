"""Download the Kokoro voice model (about 350 MB) into ./models."""

import sys
import urllib.request

from tts import MODEL_DIR, MODEL_FILE, VOICES_FILE

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {MODEL_FILE: 300_000_000, VOICES_FILE: 25_000_000}  # minimum plausible sizes


def download(path, min_size):
    if path.exists() and path.stat().st_size >= min_size:
        print(f"{path.name}: already downloaded")
        return
    tmp = path.with_suffix(path.suffix + ".part")

    def progress(blocks, block_size, total):
        done = blocks * block_size
        if total > 0:
            print(f"\r{path.name}: {min(done, total) / 1e6:.0f} / {total / 1e6:.0f} MB", end="", flush=True)

    urllib.request.urlretrieve(BASE + path.name, tmp, progress)
    print()
    if tmp.stat().st_size < min_size:
        tmp.unlink()
        sys.exit(f"{path.name}: download looks incomplete; please try again")
    tmp.replace(path)


if __name__ == "__main__":
    MODEL_DIR.mkdir(exist_ok=True)
    for path, min_size in FILES.items():
        download(path, min_size)
    print("Voice ready. Start the server with: python server.py")
