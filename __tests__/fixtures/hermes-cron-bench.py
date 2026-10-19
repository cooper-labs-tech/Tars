"""A real Hermes cron job in a throwaway HERMES_HOME: a no_agent job, whose script IS the job, posts one body to
Tars's webhook with the gateway's secret, as a user's Hermes job does. Hermes's own scheduler runs it (run_job).

Usage: python hermes-cron-bench.py <hermes tree> <home> <webhook url> <body json>

The secret comes in the environment, TARS_WEBHOOK_SECRET, never as an argument: it goes into <home>/.env (0600),
which Hermes loads for a no_agent job, and the script reads it from there. Prints one JSON line: Hermes's version,
whether the job ran, and its output, the webhook's status and answer as the script printed them."""
import json, os, sys

tree, home, url, body = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
secret = os.environ.pop('TARS_WEBHOOK_SECRET', '')
os.makedirs(os.path.join(home, 'scripts'), exist_ok=True)
os.environ['HERMES_HOME'] = home
sys.path.insert(0, tree)

env_file = os.path.join(home, '.env')
with open(os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
    f.write(f'TARS_WEBHOOK_URL={url}\nTARS_WEBHOOK_SECRET={secret}\n')

script = '''import json, os, urllib.request, urllib.error
body = %r
req = urllib.request.Request(os.environ["TARS_WEBHOOK_URL"], data=body.encode(), method="POST",
    headers={"Authorization": "Bearer " + os.environ["TARS_WEBHOOK_SECRET"], "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(json.dumps({"status": r.status, "body": json.loads(r.read() or b"{}")}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": e.code, "body": json.loads(e.read() or b"{}")}))
''' % (body,)
with open(os.path.join(home, 'scripts', 'tars-webhook.py'), 'w') as f:
    f.write(script)

from hermes_cli import __version__ as VERSION
from cron.jobs import create_job
from cron import scheduler

job = create_job(prompt=None, schedule='every 1h', name='tars-webhook', script='tars-webhook.py', no_agent=True, deliver='local')
ran = scheduler.run_job(job)
ok, _doc, output, error = (list(ran) + [None] * 4)[:4] if isinstance(ran, tuple) else (False, None, None, repr(ran))
print(json.dumps({'version': VERSION, 'job': job.get('id'), 'ok': bool(ok), 'output': output, 'error': error}))
