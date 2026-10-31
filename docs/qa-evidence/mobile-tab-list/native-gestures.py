import sys, re, json, subprocess, time
from pathlib import Path
import xml.etree.ElementTree as ET
ADB='/Users/rrd/Library/Android/sdk/platform-tools/adb'
SERIAL='emulator-5590'
OUT=Path('/tmp/mobile-tabs-native-evidence');OUT.mkdir(exist_ok=True)
def adb(*args, binary=False):
 r=subprocess.run([ADB,'-s',SERIAL,*map(str,args)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 return r.stdout if binary else r.stdout.decode()
def snapshot(name):
 remote=f'/sdcard/mobile-tabs-{name}-{time.time_ns()}.xml'
 result=adb('shell','uiautomator','dump',remote)
 assert 'dumped to' in result, result
 xml=adb('exec-out','cat',remote)
 (OUT/(name+'.xml')).write_text(xml)
 (OUT/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
 return [n.attrib for n in ET.fromstring(xml).iter('node')]
def find(nodes, ident):
 return next(n for n in nodes if n.get('resource-id')==ident)
def bounds(n):return list(map(int,re.findall(r'\d+',n['bounds'])))
def tap(nodes, ident):
 x,y,r,b=bounds(find(nodes,ident));adb('shell','input','tap',(x+r)//2,(y+b)//2)
def rows(nodes):
 return [n for n in nodes if n.get('resource-id','').startswith('workspace-tab-option-')]
name=sys.argv[1]
nodes=snapshot(name+'-workspace')
if rows(nodes):
 adb('shell','input','keyevent','4');time.sleep(.5);nodes=snapshot(name+'-workspace')
tap(nodes,'workspace-tab-switcher-trigger');time.sleep(1)
nodes=snapshot(name+'-before');rs=rows(nodes)
assert len(rs)==3,[(n.get('resource-id'),n.get('text')) for n in nodes if n.get('resource-id')]
assert any('Five minute stream' in n.get('text','')+' '+n.get('content-desc','') for n in nodes),'No model details'
print('BEFORE',[(r['resource-id'],r['bounds']) for r in rs])
source=rs[0]['resource-id'];target=rs[1]['resource-id']
x,y,r,b=bounds(rs[0]);tx,ty,tr,tb=bounds(rs[1])
sx,sy,ex,ey=(x+r)//2,(y+b)//2,(tx+tr)//2,tb-8
commands=[f'input touchscreen motionevent DOWN {sx} {sy}', 'sleep 1']
for step in range(1,13):
 commands += [f'input touchscreen motionevent MOVE {int(sx+(ex-sx)*step/12)} {int(sy+(ey-sy)*step/12)}', 'sleep .04']
commands += [f'input touchscreen motionevent UP {ex} {ey}']
adb('shell','; '.join(commands))
time.sleep(1)
nodes=snapshot(name+'-after');after=rows(nodes)
print('AFTER',[(r['resource-id'],r['bounds']) for r in after])
assert after[0]['resource-id']==target,'Native drag did not change order'
adb('shell','input','keyevent','4');time.sleep(.5)
nodes=snapshot(name+'-closed');tap(nodes,'workspace-tab-switcher-trigger');time.sleep(.6)
nodes=snapshot(name+'-reopened');assert rows(nodes)[0]['resource-id']==target,'Order lost on reopen'
print('PASS',name,'native drag and reopen order')
