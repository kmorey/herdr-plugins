"""PTY adapter for public CLI tests; JSON commands in, terminal bytes out."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


def emit(value):
    print(json.dumps(value), flush=True)


master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
pending = b""
try:
    while child.poll() is None:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in ready:
            emit({"data": base64.b64encode(os.read(master, 65536)).decode()})
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                command = json.loads(line)
                if "keys" in command:
                    os.write(master, command["keys"].encode())
                if "resize" in command:
                    rows, columns = command["resize"]
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
                    os.kill(child.pid, signal.SIGWINCH)
                if command.get("stop"):
                    child.terminate()
    if child.poll() is None:
        child.terminate()
    child.wait(timeout=3)
    while select.select([master], [], [], 0)[0]:
        emit({"data": base64.b64encode(os.read(master, 65536)).decode()})
    flags = termios.tcgetattr(slave)[3]
    emit({"exit": child.returncode, "canonical": bool(flags & termios.ICANON), "echo": bool(flags & termios.ECHO)})
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
