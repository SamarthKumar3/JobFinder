"""Read company hiring URLs and reference LinkedIn pages without modifying Excel."""
import json, sys, zipfile, re
import xml.etree.ElementTree as ET
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
urls=[]
with zipfile.ZipFile(sys.argv[1]) as z:
    shared=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        shared=[''.join(n.itertext()) for n in ET.fromstring(z.read('xl/sharedStrings.xml'))]
    for name in z.namelist():
        if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml',name):continue
        root=ET.fromstring(z.read(name))
        for c in root.findall('.//m:c',ns):
            v=c.find('m:v',ns)
            text=shared[int(v.text)] if c.get('t')=='s' and v is not None else ''.join(c.itertext())
            urls.extend(re.findall(r'https?://[^\s<>"\x27]+',text))
        relname=name.replace('/sheet','/_rels/sheet')+'.rels'
        if relname in z.namelist():
            for rel in ET.fromstring(z.read(relname)):
                if rel.get('Type','').endswith('/hyperlink'):
                    target=rel.get('Target','')
                    if target.startswith(('https://','http://')):urls.append(target)
# LinkedIn company/profile pages are references, not job descriptions or careers feeds.
urls=[u for u in dict.fromkeys(urls) if not re.search(r'(^|\.)linkedin\.com/',u.split('://')[-1],re.I)]
print(json.dumps(urls))
