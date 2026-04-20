"""Cross-platform signal helpers.

Isolates Windows-only signal constants (``SIGBREAK``) behind helpers so
mypy on Linux doesn't flag the missing attribute.
"""

from __future__ import annotations

import os
import signal

__all__ = ["interrupt_signal", "terminate_signal"]


def terminate_signal() -> signal.Signals:
    """Return the signal used to ask a subprocess to terminate gracefully.

    ``SIGTERM`` on POSIX, ``SIGBREAK`` on Windows (where ``SIGTERM`` is
    accepted by ``send_signal`` but effectively a hard kill).
    """
    if os.name == "nt":
        return signal.Signals(getattr(signal, "SIGBREAK", signal.SIGTERM))
    return signal.SIGTERM


def interrupt_signal() -> signal.Signals:
    """Return the signal used to interrupt an in-flight prompt.

    ``SIGINT`` on POSIX, ``SIGBREAK`` on Windows (Windows does not
    deliver ``SIGINT`` to non-console subprocesses reliably).
    """
    if os.name == "nt":
        return signal.Signals(getattr(signal, "SIGBREAK", signal.SIGINT))
    return signal.SIGINT
