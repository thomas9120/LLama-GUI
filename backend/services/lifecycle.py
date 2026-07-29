"""Service functions for server lifecycle: shutdown, restart, open-folder."""

import os
import socket
import subprocess
import sys
import threading
import time

from ..config import (
    RESTART_PORT_WAIT_ATTEMPTS,
    RESTART_PORT_WAIT_SECONDS,
    RESTART_STARTUP_DELAY_SECONDS,
    SUPERVISOR_RESTART_EXIT_CODE,
)


def shutdown_gui_server(ctx):
    server = ctx.state.gui_server
    if server is None:
        return False

    stop_runtime_services(ctx)
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def stop_runtime_services(ctx):
    from ..services import process_manager
    from ..services import tunnel as tunnel_service

    tunnel_service.stop_remote_tunnel(ctx)
    process_manager.stop_process(ctx)


def cleanup_gui_server(ctx):
    stop_runtime_services(ctx)
    server = ctx.state.gui_server
    if server is not None:
        server.server_close()
        ctx.state.gui_server = None
        return True
    return False


def _wait_for_port_release(gui_host, gui_port, startup_delay, wait_attempts, wait_seconds):
    time.sleep(startup_delay)
    for i in range(wait_attempts):
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind((gui_host, gui_port))
            return True
        except OSError:
            if i < wait_attempts - 1:
                time.sleep(wait_seconds)
        finally:
            if sock is not None:
                sock.close()
    return False


def restart_gui_server(ctx):
    server = ctx.state.gui_server
    if server is None:
        return False

    if ctx.config.supervised:
        ctx.state.restart_requested.set()
        print("Restart requested; handing control back to the external supervisor.")
        threading.Thread(target=server.shutdown, daemon=True).start()
        return True

    stop_runtime_services(ctx)
    restart_script = str(ctx.paths.root / "server.py")
    gui_host = ctx.config.gui_host
    gui_port = ctx.config.gui_port

    def _restart():
        try:
            port_free = _wait_for_port_release(
                gui_host,
                gui_port,
                RESTART_STARTUP_DELAY_SECONDS,
                RESTART_PORT_WAIT_ATTEMPTS,
                RESTART_PORT_WAIT_SECONDS,
            )
            if not port_free:
                print(f"WARNING: Port {gui_port} still in use after waiting, attempting restart anyway")

            # The replacement has to outlive this process on both platforms.
            # Windows gets DETACHED_PROCESS; POSIX needs start_new_session, or the
            # child stays in our process group and dies with the terminal or on
            # the next Ctrl+C — so "restart" silently became "quit".
            popen_kwargs = {}
            if sys.platform == "win32":
                popen_kwargs["creationflags"] = (
                    subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                )
            else:
                popen_kwargs["start_new_session"] = True
            subprocess.Popen(
                [sys.executable, restart_script],
                cwd=str(ctx.paths.root),
                **popen_kwargs,
            )
            print("Restarting Llama GUI...")
        except Exception as e:
            print(f"ERROR: Failed to restart server: {e}")
            import traceback

            traceback.print_exc()
            return
        os._exit(0)

    threading.Thread(target=_restart, daemon=False).start()
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def get_gui_exit_code(ctx):
    if ctx.config.supervised and ctx.state.restart_requested.is_set():
        return SUPERVISOR_RESTART_EXIT_CODE
    return 0


def open_folder_in_file_manager(target):
    if sys.platform == "win32":
        os.startfile(str(target))
        return
    if sys.platform == "darwin":
        subprocess.run(["open", str(target)], check=False)
        return
    subprocess.run(["xdg-open", str(target)], check=False)
