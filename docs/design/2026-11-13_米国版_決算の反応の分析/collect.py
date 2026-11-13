# 直近1か月の米国決算（Finnhub）と日足（Yahoo）を集める。使い方: python collect.py data.json
# Finnhub のキーは環境変数 FINNHUB_API_KEY（無ければ付けない。クラウドではネットワークの仕組みが付けていた）
# Yahoo は同時に取りすぎると止められるので、株価が空なら prices.py で取り直す
import json,os,urllib.request,datetime,concurrent.futures as cf,time,sys
UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36'}
def get(u):
    for i in range(3):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=30))
        except Exception as e: err=e; time.sleep(1+i)
    raise err
rows={}
d=datetime.date(2026,10,12)
while d<datetime.date(2026,11,13):
    e=d+datetime.timedelta(days=3)
    try: cal=get(f'https://finnhub.io/api/v1/calendar/earnings?from={d}&to={e}'+('&token='+os.environ['FINNHUB_API_KEY'] if os.environ.get('FINNHUB_API_KEY') else '')).get('earningsCalendar',[])
    except Exception as ex: print('fh',d,ex,file=sys.stderr); cal=[]
    for r in cal:
        if (r.get('revenueEstimate') or 0)>=1e9 and r.get('epsActual') is not None and r.get('revenueActual') and r.get('hour') in ('bmo','amc') and r.get('epsEstimate') is not None:
            rows[(r['symbol'],r['date'])]=r
    d=e+datetime.timedelta(days=1)
rows=list(rows.values()); print('earnings rows',len(rows),file=sys.stderr)
def closes(sym):
  try:
    return _closes(sym)
  except Exception as e:
    print('skip',sym,e,file=sys.stderr); return {}
def _closes(sym):
    j=get(f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?period1=1790812800period1=1759276800&period2=1763078400period2=1794614400&interval=1d')
    r=j['chart']['result'][0]; out={}
    for t,c in zip(r['timestamp'],r['indicators']['quote'][0]['close']):
        if c: out[(datetime.datetime.utcfromtimestamp(t)-datetime.timedelta(hours=5)).date().isoformat()]=c
    return out
import urllib.parse
syms=sorted({r['symbol'] for r in rows})+['^GSPC']
px={}
with cf.ThreadPoolExecutor(2) as ex:
    for s,res in zip(syms,ex.map(lambda s:(lambda:closes(s))() if True else None, syms)):
        px[s]=res
json.dump({'rows':rows,'px':px},open(sys.argv[1],'w'))
