"""Public collection with exact source timestamps retained before JobSpy date truncation."""
import json, sys, contextlib, re, time
from datetime import datetime, timezone
from jobspy import scrape_jobs
from jobspy.indeed import Indeed
from jobspy.naukri import Naukri
from jobspy.linkedin import LinkedIn
posted_times={}
_orig_indeed=Indeed._process_job
def indeed_job(self, job):
    posted_times['in-'+job['key']]=job['dateOnIndeed']/1000
    return _orig_indeed(self,job)
Indeed._process_job=indeed_job
_orig_naukri=Naukri._process_job
def naukri_job(self,job):
    posted_times['nk-'+job['jobId']]=job.get('createdDate',0)/1000
    return _orig_naukri(self,job)
Naukri._process_job=naukri_job
_orig_details=Naukri._fetch_details
def naukri_details(self,job_id):
    details=_orig_details(self,job_id)
    if details.get('posted'):posted_times['nk-'+job_id]=details['posted']
    return details
Naukri._fetch_details=naukri_details
_orig_linkedin=LinkedIn._process_job
def linkedin_job(self,card,job_id):
    element=card.find('time')
    if element:
        raw=element.get('datetime','')
        if len(raw)>10:
            try:posted_times['li-'+job_id]=datetime.fromisoformat(raw.replace('Z','+00:00')).timestamp()
            except ValueError:pass
        else:
            # Use a conservative lower bound for rounded relative labels.
            m=re.search(r'(\d+)\s*(minute|hour|second)',element.get_text(' ',strip=True),re.I)
            if m:posted_times['li-'+job_id]=time.time()-(int(m[1])+1)*{'second':1,'minute':60,'hour':3600}[m[2].lower()]
    return _orig_linkedin(self,card,job_id)
LinkedIn._process_job=linkedin_job
cfg=json.load(sys.stdin)
jobs,errors=[],[]
for site,location in [(s,l) for s in cfg['sites'] for l in cfg.get('locations',[cfg['location']])]:
    for term in cfg['terms']:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                frame=scrape_jobs(site_name=[site],search_term=term,location=location,
                    results_wanted=cfg['resultsPerSearch'],hours_old=24,country_indeed=cfg['country'],
                    linkedin_fetch_description=True,fetch_description=True,description_format='markdown',verbose=0)
            records=json.loads(frame.to_json(orient='records',date_format='iso'))
            valid=0; skipped_age=0
            for row in records:
                posted=posted_times.get(row.get('id'),0)
                if not posted or posted<time.time()-86400 or posted>time.time():
                    skipped_age+=1;continue
                row['posted_at']=datetime.fromtimestamp(posted,timezone.utc).isoformat()
                desc=row.get('description') or ''
                if len(desc)<50:
                    errors.append(f"{site}: incomplete description for {row.get('job_url')}; skipped evaluation");continue
                jobs.append(dict(title=row.get('title') or 'Unknown role',company=row.get('company') or 'Undisclosed employer',
                    location=row.get('location') or '',source=site,apply_url=row.get('job_url_direct') or row['job_url'],description=desc,metadata=row))
                valid+=1
            if skipped_age:errors.append(f'{site} / {term}: skipped {skipped_age} old or unconfirmed-date postings (strict 24-hour window)')
            if not valid:errors.append(f'{site} / {term}: no complete verified jobs from the last 24 hours; source may be blocked or have no results')
        except Exception as exc:errors.append(f'{site} / {term}: {type(exc).__name__}: {str(exc)[:300]}')
print(json.dumps(dict(jobs=jobs,errors=errors),allow_nan=False))
