# collect.py で株価が取れなかった銘柄を、1件ずつ間隔をあけて Yahoo から取り直す。使い方: python prices.py data.json
import json,sys,time,urllib.request,urllib.parse,datetime,collections
p=sys.argv[1]; D=json.load(open(p))
UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36'}
errs=collections.Counter()
syms=['^GSPC']+sorted({r['symbol'] for r in D['rows']})
for i,s in enumerate(syms):
    if D['px'].get(s): continue
    for t in range(4):
        try:
            j=json.load(urllib.request.urlopen(urllib.request.Request(f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(s)}?period1=1790812800&period2=1794614400&interval=1d',headers=UA),timeout=30))
            r=j['chart']['result'][0]; out={}
            for ts,c in zip(r.get('timestamp',[]),r['indicators']['quote'][0]['close']):
                if c: out[(datetime.datetime.utcfromtimestamp(ts)-datetime.timedelta(hours=5)).date().isoformat()]=c
            D['px'][s]=out; break
        except urllib.error.HTTPError as e:
            errs[e.code]+=1
            if e.code==429: time.sleep(10*(t+1)); continue
            break
        except Exception as e: errs[type(e).__name__]+=1; break
    time.sleep(0.3)
    if i%100==0: print(i,dict(errs),file=sys.stderr,flush=True)
json.dump(D,open(p,'w')); print('done',sum(1 for v in D['px'].values() if v),dict(errs),file=sys.stderr)
