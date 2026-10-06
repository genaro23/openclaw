import os,sys,json,time,subprocess,tempfile
from pathlib import Path
BASE=Path(__file__).resolve().parent
if '--inner' not in sys.argv:
 with tempfile.TemporaryDirectory(prefix='native-sidebar-proof-') as temp:
  root=Path(temp);env={k:os.environ[k] for k in ('DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY') if k in os.environ}
  env.update(HOME=temp,PATH='/usr/bin:/bin',LANG='C.UTF-8',GDK_BACKEND='x11',XDG_SESSION_TYPE='x11',GTK_MODULES='atk-bridge',NO_AT_BRIDGE='0')
  for k,v in [('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state'),('XDG_RUNTIME_DIR','runtime')]:
   (root/v).mkdir(mode=0o700);env[k]=str(root/v)
  d=json.loads((BASE/'private-login.json').read_text());url=d['wsUrl'];oc=root/'.openclaw';(oc/'bin').mkdir(parents=True)
  (oc/'openclaw.json').write_text(json.dumps({'gateway':{'mode':'local','port':int(url.rsplit(':',1)[1])}}))
  (oc/'dashboard.json').write_text(json.dumps(d))
  cli=oc/'bin/openclaw';cli.write_text('''#!/usr/bin/python3
import sys,json
from pathlib import Path
c=' '.join(sys.argv[1:])
if c=='--version':print('OpenClaw isolated native validation')
elif c=='gateway status --json':print(json.dumps({'service':{'loaded':True,'runtime':{'status':'running'}},'rpc':{'ok':True}}))
elif c=='dashboard --json --no-open':print((Path.home()/'.openclaw/dashboard.json').read_text())
else:raise RuntimeError('Blocked unexpected CLI operation: '+c)
''');cli.chmod(0o700)
  sys.exit(subprocess.run(['/usr/bin/python3',__file__,'--inner'],env=env,timeout=240).returncode)
import gi
gi.require_version('Atspi','2.0');gi.require_version('Gdk','3.0')
from gi.repository import Atspi,Gdk
Atspi.set_timeout(700,700)
vault=subprocess.Popen(['gnome-keyring-daemon','--foreground','--unlock','--components=secrets'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
vault.stdin.write(b'isolated-test-vault\n');vault.stdin.close();time.sleep(2)
log=(BASE/'native.log').open('w');app=subprocess.Popen([str(BASE/'app/usr/bin/openclaw-desktop')],stdout=log,stderr=log)
def nodes():
 desktop=Atspi.get_desktop(0);pending=[desktop];count=0
 while pending and count<1500:
  n=pending.pop();count+=1
  if n is None:continue
  yield n
  try:pending.extend(n.get_child_at_index(i) for i in range(n.get_child_count()))
  except:pass
def dump():
 out=[]
 for n in nodes():
  try:
   name=n.get_name();role=n.get_localized_role_name()
   if name:out.append([role,name[:160]])
  except:pass
 return out
def capture(name):
 time.sleep(1);w=Gdk.get_default_root_window();pix=Gdk.pixbuf_get_from_window(w,0,0,w.get_width(),w.get_height());pix.savev(str(BASE/name),'png',[],[])
try:
 for i in range(60):
  tree=dump();(BASE/'tree.json').write_text(json.dumps(tree,indent=2))
  if any('Clear finished workers after' in x[1] for x in tree):break
  if app.poll() is not None:raise RuntimeError('App exited')
  time.sleep(1)
 capture('native-initial.png');print(json.dumps(tree),flush=True)
 # Drive the real native select and toggle via accessibility and keyboard.
 def click_name(name):
  for n in nodes():
   if n.get_name()==name:
    a=n.get_action_iface()
    if a and a.get_n_actions() and a.do_action(0):return
  raise RuntimeError('Cannot activate '+name)
 click_name('Clear finished workers after');time.sleep(.5)
 subprocess.run(['xdotool','key','--clearmodifiers','End','Return'],check=True)
 time.sleep(4);capture('native-retention-60.png')
 click_name('Show retained worker history');time.sleep(2)
 assert any(n.get_name()=='Hide retained worker history' for n in nodes()),'History toggle failed'
 capture('native-history-shown.png')
 subprocess.run(['xdotool','key','--clearmodifiers','ctrl+r'],check=True)
 time.sleep(8);capture('native-after-reload.png')
 (BASE/'native-result.json').write_text(json.dumps({'nativeSystemsRendered':True,'nativeRetentionSelectDrivenTo60':True,'historyTogglePassed':True,'reloadKeySent':True}))
 print('Native interaction sequence complete',flush=True)
 # Leave bounded window for externally driven commands.
 for i in range(140):
  cmd=BASE/'action.json'
  if cmd.exists():
   action=json.loads(cmd.read_text());cmd.unlink()
   if action['kind']=='stop':break
   if action['kind']=='capture':capture(action['name'])
   if action['kind']=='key':subprocess.run(['xdotool','key','--clearmodifiers',*action['key'].split()],check=True)
   if action['kind']=='click':
    for n in nodes():
     if n.get_name()==action['name']:
      a=n.get_action_iface()
      if a and a.get_n_actions():a.do_action(0);break
   time.sleep(1);(BASE/'tree.json').write_text(json.dumps(dump(),indent=2))
  time.sleep(.5)
finally:
 app.terminate()
 try:app.wait(timeout=8)
 except:app.kill();app.wait()
 log.close();vault.terminate();vault.wait(timeout=5)
