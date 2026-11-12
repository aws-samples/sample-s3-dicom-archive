"""GPU smoke-test plugin: proves a step got a GPU on the plugin GPU queue.

Runs nvidia-smi (the NVIDIA container runtime mounts it into any container that
was allocated a GPU) and stores its report as the step output.
"""
import subprocess

from plugin_sdk import Step


def main():
    with Step() as step:
        r = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],  # nosec B603 -- static argv list, no shell, no user-controlled command
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            step.fail(f'nvidia-smi failed (exit {r.returncode}): {(r.stderr or r.stdout)[-500:]}')
            return
        full = subprocess.run(['nvidia-smi'], capture_output=True, text=True, timeout=60).stdout  # nosec B603 -- static argv list, no shell, no user-controlled command
        step.put_output('nvidia-smi.txt', full.encode(), 'text/plain', label='nvidia-smi')
        gpus = [line.strip() for line in r.stdout.splitlines() if line.strip()]
        step.metric('gpus', gpus)
        step.succeed(f'{len(gpus)} GPU(s): ' + '; '.join(gpus))


if __name__ == '__main__':
    main()
