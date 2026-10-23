# Helm voice input: a local speech-to-text worker (faster-whisper on the CPU). Owner: lane voice.
# main/voice.js starts it with `python -u whisper_worker.py` and talks JSON lines over stdin/stdout:
#   {"id":1,"op":"probe","model":"base.en"}  -> {"id":1,"ok":true,"python":"3.13.x","fw":"1.x","model":"base.en","cached":true}
#   {"id":2,"op":"load","model":"base.en"}   -> {"id":2,"ok":true,"loadMs":812}
#   {"id":3,"op":"transcribe","pcm":"<base64 Int16LE mono 16 kHz>"} -> {"id":3,"ok":true,"text":"...","audioMs":3100,"ms":640}
#   failures: {"id":n,"ok":false,"code":"no_module|no_model|bad_audio|failed","error":"<reason for the UI>"}
# Private by construction: audio arrives in memory, is decoded to a numpy array, transcribed and dropped.
# Nothing is written to disk, and the model is opened with local_files_only (HF_HUB_OFFLINE=1 is also
# set by main/voice.js), so no audio or text ever leaves the machine.
import base64
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

_model = None
_model_name = None


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(req_id, code, error):
    out({"id": req_id, "ok": False, "code": code, "error": error})


def import_fw():
    try:
        import faster_whisper  # noqa: F401
        return faster_whisper, None
    except Exception as e:  # ImportError, or a broken native dependency
        return None, "faster-whisper is not installed for this Python (%s): pip install faster-whisper" % (type(e).__name__)


def model_cached(name):
    from faster_whisper.utils import download_model
    try:
        download_model(name, local_files_only=True)
        return True
    except Exception:
        return False


def threads():
    try:
        n = int(os.environ.get("HELM_VOICE_THREADS", "0"))
    except ValueError:
        n = 0
    return n if n > 0 else max(1, min(4, (os.cpu_count() or 2) - 1))


def op_probe(req):
    fw, err = import_fw()
    if not fw:
        return fail(req.get("id"), "no_module", err)
    name = req.get("model") or "base.en"
    out({"id": req.get("id"), "ok": True, "python": sys.version.split()[0], "fw": getattr(fw, "__version__", "?"),
         "model": name, "cached": model_cached(name)})


def op_load(req):
    global _model, _model_name
    name = req.get("model") or "base.en"
    if _model is not None and _model_name == name:
        return out({"id": req.get("id"), "ok": True, "loadMs": 0, "model": name})
    fw, err = import_fw()
    if not fw:
        return fail(req.get("id"), "no_module", err)
    if not model_cached(name):
        return fail(req.get("id"), "no_model",
                    "The Whisper model %s is not on this PC. Download it once with: "
                    "py -c \"from faster_whisper import WhisperModel; WhisperModel('%s')\"" % (name, name))
    t0 = time.perf_counter()
    try:
        _model = fw.WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads(), local_files_only=True)
        _model_name = name
    except Exception as e:
        _model = None
        return fail(req.get("id"), "failed", "Whisper could not load %s: %s" % (name, e))
    # Warm-up pass on 1 s of faint noise (no VAD, so the encoder and decoder really run): the first real
    # transcription is ~1 s faster, and this runs while the user is still speaking.
    try:
        import numpy as np
        noise = (np.random.default_rng(0).standard_normal(16000) * 0.001).astype(np.float32)
        for _s in _model.transcribe(noise, language="en", beam_size=1, vad_filter=False, without_timestamps=True)[0]:
            pass
    except Exception:
        pass
    out({"id": req.get("id"), "ok": True, "loadMs": int((time.perf_counter() - t0) * 1000), "model": name})


def op_transcribe(req):
    import numpy as np
    if _model is None:
        op_load({"id": None, "model": req.get("model")})
        if _model is None:
            return fail(req.get("id"), "failed", "The Whisper model is not loaded")
    try:
        raw = base64.b64decode(req.get("pcm") or "", validate=True)
    except Exception:
        return fail(req.get("id"), "bad_audio", "The recording did not arrive intact (bad base64)")
    if len(raw) < 2 or len(raw) % 2:
        return fail(req.get("id"), "bad_audio", "The recording is empty")
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    del raw
    audio_ms = int(len(audio) / 16.0)
    t0 = time.perf_counter()
    try:
        segments, _info = _model.transcribe(
            audio,
            language="en",
            beam_size=int(req.get("beam") or 1),
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    except Exception as e:
        return fail(req.get("id"), "failed", "Whisper failed on this recording: %s" % e)
    finally:
        del audio
    out({"id": req.get("id"), "ok": True, "text": text, "audioMs": audio_ms, "ms": int((time.perf_counter() - t0) * 1000)})


OPS = {"probe": op_probe, "load": op_load, "transcribe": op_transcribe}


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    out({"hello": True, "pid": os.getpid(), "exe": sys.executable})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            fail(None, "failed", "bad request line")
            continue
        fn = OPS.get(req.get("op"))
        if not fn:
            fail(req.get("id"), "failed", "unknown op %r" % req.get("op"))
            continue
        try:
            fn(req)
        except Exception as e:  # never die on one bad request
            fail(req.get("id"), "failed", "%s: %s" % (type(e).__name__, e))


if __name__ == "__main__":
    main()
