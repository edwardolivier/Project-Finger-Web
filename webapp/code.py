# ═══════════════════════════════════════════════════════════════════════════════
# code.py  —  Password Dongle Firmware  (consumer build)
# Runs in two modes, decided at boot by the presence of /setup_done.txt:
#   SETUP  — listens on USB CDC serial for commands from the web setup wizard
#   LOCKED — fingerprint HID loop; no drive or serial visible to host
# ═══════════════════════════════════════════════════════════════════════════════
import board, busio, time, os, hashlib, aesio, sys, supervisor
import usb_hid
import adafruit_fingerprint
from adafruit_hid.keyboard import Keyboard
import microcontroller, storage

# ── Constants ────────────────────────────────────────────────────────────────
CONFIDENCE_THRESHOLD = 50
MAX_FAILS            = 5
F_SETUP_DONE         = "/setup_done.txt"
F_ENC_KEY            = "/enc_key.txt"
F_PASSWORDS          = "/passwords.enc"
F_FAIL_COUNT         = "/fail_count.txt"
F_LAYOUT             = "/layout.txt"


# ── AES-128-CTR helpers ──────────────────────────────────────────────────────
def _derive_key(secret: str) -> bytes:
    h = hashlib.new("sha256")
    h.update(secret.encode())
    return h.digest()[:16]

def _aes_ctr(data: bytes, key: bytes, nonce: bytes) -> bytes:
    buf = bytearray(len(data))
    aesio.AES(key, aesio.MODE_CTR, bytearray(nonce)).encrypt_into(bytearray(data), buf)
    return bytes(buf)

def _b2h(b: bytes) -> str:
    return "".join("{:02x}".format(x) for x in b)

def _h2b(h: str) -> bytes:
    return bytes(int(h[i:i+2], 16) for i in range(0, len(h), 2))


# ── Password file ────────────────────────────────────────────────────────────
def load_passwords(enc_key: str) -> dict:
    key, result = _derive_key(enc_key), {}
    try:
        with open(F_PASSWORDS, "r") as f:
            for line in f.read().splitlines():
                line = line.strip()
                if not line or line.count(":") < 2:
                    continue
                slot_s, nonce_h, ct_h = line.split(":", 2)
                plaintext = _aes_ctr(_h2b(ct_h), key, _h2b(nonce_h))
                result[int(slot_s)] = plaintext.decode("utf-8")
    except:
        pass
    return result

def save_password(slot: int, plaintext: str, enc_key: str):
    key   = _derive_key(enc_key)
    nonce = os.urandom(16)
    ct    = _aes_ctr(plaintext.encode("utf-8"), key, nonce)
    new_line = f"{slot}:{_b2h(nonce)}:{_b2h(ct)}"
    lines = []
    try:
        with open(F_PASSWORDS, "r") as f:
            lines = [l for l in f.read().splitlines()
                     if l.strip() and not l.startswith(f"{slot}:")]
    except:
        pass
    lines.append(new_line)
    with open(F_PASSWORDS, "w") as f:
        f.write("\n".join(lines))


# ── Fail counter ─────────────────────────────────────────────────────────────
def read_fails() -> int:
    try:
        with open(F_FAIL_COUNT, "r") as f:
            return int(f.read().strip())
    except:
        return 0

def write_fails(n: int):
    with open(F_FAIL_COUNT, "w") as f:
        f.write(str(n))


# ── Self-destruct ─────────────────────────────────────────────────────────────
def wipe_all(sensor):
    for slot in range(1, 201):
        sensor.delete_model(slot)
    for path in (F_PASSWORDS, F_FAIL_COUNT):
        try:
            size = os.stat(path)[6]
            with open(path, "wb") as f:
                f.write(b"\x00" * size)
            os.remove(path)
        except:
            pass


# ── Mode check ────────────────────────────────────────────────────────────────
def _is_locked() -> bool:
    try:
        with open(F_SETUP_DONE, "r") as f:
            return f.read().strip() == "1"
    except:
        return False


# ── Keyboard layout loader ────────────────────────────────────────────────────
def _load_layout(kbd):
    """
    Load the keyboard layout stored in /layout.txt.
    Tries to import the matching community layout .mpy if available,
    falls back to US if the file is missing or the library is not installed.
    Community layout files (keyboard_layout_win_XX.mpy) from:
      https://github.com/Neradoc/Circuitpython_Keyboard_Layouts
    Copy the required .mpy into CIRCUITPY/lib/ to activate non-US layouts.
    """
    code = "US"
    try:
        with open(F_LAYOUT, "r") as f:
            code = f.read().strip().upper()
    except:
        pass

    layout_map = {
        "UK": "keyboard_layout_win_uk",
        "FR": "keyboard_layout_win_fr",
        "DE": "keyboard_layout_win_de",
        "ES": "keyboard_layout_win_es",
        "IT": "keyboard_layout_win_it",
    }

    if code in layout_map:
        try:
            mod = __import__(layout_map[code])
            return mod.KeyboardLayout(kbd)
        except ImportError:
            pass   # library not installed — fall through to US

    from adafruit_hid.keyboard_layout_us import KeyboardLayoutUS
    return KeyboardLayoutUS(kbd)


# ── Hardware ──────────────────────────────────────────────────────────────────
_uart   = busio.UART(board.GP0, board.GP1, baudrate=57600)
finger  = adafruit_fingerprint.Adafruit_Fingerprint(_uart)
LOCKED  = _is_locked()


# ══════════════════════════════════════════════════════════════════════════════
# LOCKED MODE
# Touch pin removed — poll sensor directly (touch pin wiring is optional on
# R503-F and caused the device to silently idle when not connected).
# ══════════════════════════════════════════════════════════════════════════════
if LOCKED:
    kbd    = Keyboard(usb_hid.devices)
    layout = _load_layout(kbd)

    try:
        with open(F_ENC_KEY, "r") as f:
            enc_key = f.read().strip()
    except:
        enc_key = ""

    passwords  = load_passwords(enc_key)
    fail_count = read_fails()
    finger.set_led(color=2, mode=1)   # breathing blue = ready

    while True:
        if finger.get_image() != adafruit_fingerprint.OK:
            time.sleep(0.1)
            continue

        if finger.image_2_tz(1) != adafruit_fingerprint.OK:
            continue

        matched    = finger.finger_search() == adafruit_fingerprint.OK
        slot       = finger.finger_id  if matched else -1
        confidence = finger.confidence if matched else 0

        if matched and confidence >= CONFIDENCE_THRESHOLD and slot in passwords:
            fail_count = 0
            write_fails(0)
            finger.set_led(color=2, mode=2)   # flash blue = success
            time.sleep(0.1)
            layout.write(passwords[slot])
            finger.set_led(color=2, mode=1)
        else:
            fail_count += 1
            write_fails(fail_count)
            finger.set_led(color=1, mode=2)   # flash red = fail
            time.sleep(0.5)
            finger.set_led(color=2, mode=1)
            if fail_count >= MAX_FAILS:
                wipe_all(finger)
                microcontroller.reset()

        while finger.get_image() != adafruit_fingerprint.NOFINGER:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# SETUP MODE  —  serial command protocol for the web setup wizard
# Uses sys.stdin/stdout (console port) — the most reliable serial interface
# on all platforms. boot.py enables console=True, data=False so exactly one
# COM port appears and the user cannot pick the wrong one.
# ══════════════════════════════════════════════════════════════════════════════
else:
    enc_key  = ""
    _rxbuf_s = ""

    def _tx(msg: str):
        sys.stdout.write(msg + "\n")

    def _rx_line(timeout_s: float = 60.0) -> str:
        global _rxbuf_s
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            n = supervisor.runtime.serial_bytes_available
            if n:
                chars = sys.stdin.read(n)
                for c in chars:
                    if c in ("\n", "\r"):
                        if _rxbuf_s:
                            line = _rxbuf_s.strip()
                            _rxbuf_s = ""
                            return line
                    else:
                        _rxbuf_s += c
            time.sleep(0.005)
        return ""

    def _enroll(slot: int):
        _tx(f"PLACE_FINGER:{slot}")
        finger.set_led(color=2, mode=3)

        t0 = time.monotonic()
        while time.monotonic() - t0 < 30:
            if finger.get_image() == adafruit_fingerprint.OK:
                break
            time.sleep(0.05)
        else:
            _tx("FAIL:timeout")
            return

        if finger.image_2_tz(1) != adafruit_fingerprint.OK:
            _tx("FAIL:image1")
            return

        _tx(f"LIFT_FINGER:{slot}")
        finger.set_led(color=3, mode=3)
        while finger.get_image() != adafruit_fingerprint.NOFINGER:
            time.sleep(0.05)
        time.sleep(0.4)

        _tx(f"PLACE_AGAIN:{slot}")
        finger.set_led(color=2, mode=3)

        t0 = time.monotonic()
        while time.monotonic() - t0 < 30:
            if finger.get_image() == adafruit_fingerprint.OK:
                break
            time.sleep(0.05)
        else:
            _tx("FAIL:timeout")
            return

        if finger.image_2_tz(2) != adafruit_fingerprint.OK:
            _tx("FAIL:image2")
            return

        if finger.create_model() != adafruit_fingerprint.OK:
            _tx("FAIL:no_match")
            return

        if finger.store_model(slot) != adafruit_fingerprint.OK:
            _tx("FAIL:store")
            return

        finger.set_led(color=2, mode=1)
        _tx(f"OK:{slot}")

    finger.set_led(color=3, mode=1)
    time.sleep(1)
    _tx("READY:SETUP_MODE")

    while True:
        if not supervisor.runtime.serial_bytes_available:
            time.sleep(0.01)
            continue

        cmd = _rx_line()
        if not cmd:
            continue

        if cmd == "PING":
            _tx("PONG")

        elif cmd == "STATUS":
            _tx("STATUS:SETUP_MODE")

        elif cmd.startswith("SET_KEY:"):
            enc_key = cmd[8:]
            with open(F_ENC_KEY, "w") as f:
                f.write(enc_key)
            _tx("OK:KEY_SET")

        elif cmd.startswith("SET_LAYOUT:"):
            with open(F_LAYOUT, "w") as f:
                f.write(cmd[11:].strip().upper())
            _tx("OK:LAYOUT_SET")

        elif cmd.startswith("ENROLL:"):
            _enroll(int(cmd[7:]))

        elif cmd.startswith("SET_PASSWORD:"):
            rest  = cmd[13:]
            colon = rest.index(":")
            slot  = int(rest[:colon])
            pw    = rest[colon + 1:]
            if not enc_key:
                _tx("FAIL:no_key")
            else:
                save_password(slot, pw, enc_key)
                _tx(f"OK:PASSWORD:{slot}")

        elif cmd == "LOCK_DOWN":
            _tx("LOCKING")
            with open(F_SETUP_DONE, "w") as f:
                f.write("1")
            time.sleep(0.3)
            microcontroller.reset()

        elif cmd == "FACTORY_RESET":
            wipe_all(finger)
            for path in (F_PASSWORDS, F_FAIL_COUNT, F_SETUP_DONE, F_ENC_KEY, F_LAYOUT):
                try:
                    os.remove(path)
                except:
                    pass
            _tx("OK:RESET")
            time.sleep(0.3)
            microcontroller.reset()

        time.sleep(0.01)
