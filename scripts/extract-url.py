"""Individual public Naukri posting retrieval using the installed JobSpy transport."""
import sys,json,re
from urllib.parse import urlparse
from datetime import datetime
from jobspy.util import create_session,format_description
from jobspy.model import DescriptionFormat
from jobspy.naukri.constant import job_page_headers,india_time
from jobspy.naukri.util import generate_nkparam
url=json.load(sys.stdin)['url']
u=urlparse(url)
if u.scheme!='https' or u.hostname not in ('www.naukri.com','naukri.com','m.naukri.com'):
    raise ValueError('Unsupported posting host')
m=re.search(r'(\d{12})(?:/)?$',u.path)
if not m:raise ValueError('Paste an individual Naukri job-listings URL')
job_id=m[1]
r=create_session().get('https://www.naukri.com/jobapi/v4/job/'+job_id,headers=job_page_headers|{'nkparam':generate_nkparam(job_id)},timeout=20)
if r.status_code!=200:raise RuntimeError(f'Naukri HTTP {r.status_code}; paste the description instead')
j=r.json()['jobDetails'];company=j.get('companyDetail') or {}
description,_=format_description(j.get('description'),DescriptionFormat.MARKDOWN)
posted=None
if j.get('createdDate'):
    posted=datetime.strptime(j['createdDate'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=india_time).isoformat()
print(json.dumps(dict(title=j.get('title') or '',company=company.get('name') or company.get('companyName') or j.get('companyName') or '',
 location=', '.join(x.get('label') or x.get('name') or '' for x in j.get('locations',[]) if isinstance(x,dict)),description=description or '',source='naukri',apply_url=url,
 metadata={'manual_url':True,'posted_at':posted,'experience_range':j.get('experienceText'), 'source_job_id':job_id})))
