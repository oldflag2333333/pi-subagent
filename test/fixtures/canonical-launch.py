"""Exercise the launcher through a real canonical-mode PTY, without a model call."""
import errno
import json
import os
import pty
import select
import signal
import subprocess
import termios
import time

command = 'sh "$PI_SUBAGENT_LAUNCH"'
master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
attrs[3] |= termios.ICANON | termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
canonical = bool(termios.tcgetattr(slave)[3] & termios.ICANON)
# Unlike an interactive line editor, this reader never switches off ICANON.
child = subprocess.Popen(
    ["sh", "-c", 'IFS= read -r command; eval "$command"'],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
output = bytearray()
try:
    os.write(master, command.encode() + b"\n")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        output.extend(data)
    child.wait(timeout=1)
    if child.returncode != 0:
        raise RuntimeError(output.decode(errors="replace"))
    lines = output.decode().splitlines()
    args = json.loads(lines[-1])
    print(json.dumps({"canonical": canonical, "input_bytes": len(command.encode()) + 1, "args": args}))
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
