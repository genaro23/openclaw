from pathlib import Path
import subprocess,re,json,hashlib
import sys
repo=sys.argv[1] if len(sys.argv)>1 else '.'
out=Path(__file__).resolve().parent
base='bb3a8a9ac304fbec8367fd64d9644bb12d956e9c'
head='cbc3e2731fb7b1cdf8eb3705aec5212f4451149b'
path='apps/ios/Sources/RootTabsNavigation.swift'
def source(ref):return subprocess.check_output(['git','-C',repo,'show',ref+':'+path],text=True)
def extract(s,name):
 start=s.index('    '+name); b=s.index('{',start); depth=1;i=b+1
 while depth:
  depth+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[start:i]
def owner(s,name):
 cases=s[s.index('        case chat'):s.index('        var id:')]
 destinations=re.search(r'    static let sidebarDestinations:.*?\n    \]',s,re.S).group()
 defaults=re.search(r'    static let defaultPinnedSidebarPages:.*',s).group()
 return 'enum '+name+' {\n enum SidebarDestination: String, CaseIterable {\n'+cases+'\n}\n'+destinations+'\n static let pinnableSidebarPages = sidebarDestinations.filter { $0 != .chat }\n'+defaults+'\n'+extract(s,'static func pinnedSidebarPages(from')+'\n'+extract(s,'static func pinnedSidebarPagesStorage(')+'\n}\n'
a,b=source(base),source(head)
assert extract(a,'static func pinnedSidebarPages(from')==extract(b,'static func pinnedSidebarPages(from')
assert extract(a,'static func pinnedSidebarPagesStorage(')==extract(b,'static func pinnedSidebarPagesStorage(')
code='import Foundation\n'+owner(a,'Old')+owner(b,'New')+r'''
var count = 0
func check(_ raw: String) {
 let old = Old.pinnedSidebarPages(from: raw).map(\.rawValue)
 let new = New.pinnedSidebarPages(from: raw).map(\.rawValue)
 precondition(old == new, "Changed saved layout: \(raw)")
 let saved = New.pinnedSidebarPagesStorage(New.pinnedSidebarPages(from: raw))
 precondition(New.pinnedSidebarPages(from: saved).map(\.rawValue) == old, "Roundtrip: \(raw)")
 precondition(!new.contains("systems"), "Forced Systems into saved layout")
 count += 1
}
let keys = Old.pinnableSidebarPages.map(\.rawValue)
for mask in 0..<(1 << keys.count) {
 let subset = keys.enumerated().filter { mask & (1 << $0.offset) != 0 }.map { $0.element }
 check(subset.isEmpty ? "none" : subset.joined(separator: ","))
 check(subset.isEmpty ? "none" : subset.reversed().joined(separator: ","))
}
for a in keys { for b in keys where a != b { check(a + "," + b) } }
for raw in ["none", "usage,usage,docs", "chat,bogus", "chat,overview", "usage,,docs", ",", "unknown", "settings,gateway", " usage,docs ", "usage, docs", "none,usage", "usage,unknown,docs"] { check(raw) }
for raw in ["", " ", "\n"] {
 precondition(Old.pinnedSidebarPages(from: raw).map(\.rawValue) == ["overview","usage","cron"])
 precondition(New.pinnedSidebarPages(from: raw).map(\.rawValue) == ["overview","systems","usage","cron"])
}
precondition(New.pinnedSidebarPages(from:"docs,systems,usage").map(\.rawValue) == ["docs","systems","usage"])
print("PASS: \(count) saved-layout differential + round-trip cases; \(1 << keys.count) subsets, forward/reverse ordering, all ordered pairs, edge cases; 3 intentional default cases; explicit Systems opt-in.")
'''
(out/'CompatibilityProof.swift').write_text(code)
(out/'provenance.json').write_text(json.dumps({'base':base,'head':head,'source':path,'old_sha256':hashlib.sha256(a.encode()).hexdigest(),'new_sha256':hashlib.sha256(b.encode()).hexdigest(),'method':'Compile exact extracted production preference methods and destination sets; not a full app test.'},indent=2)+'\n')
