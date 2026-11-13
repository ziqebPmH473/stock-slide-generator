# 予想との差の幅ごとに、決算の翌日（寄り前は当日）の株価の動き（S&P500 との差）をまとめる。使い方: python analyze.py data.json
import json,sys,statistics as st
D=json.load(open(sys.argv[1])); px=D['px']; sp=px['^GSPC']
days=sorted(sp)
def ret(p,d0,d1): return p[d1]/p[d0]-1 if d0 in p and d1 in p else None
recs=[]
for r in D['rows']:
    p=px.get(r['symbol']) or {}
    d=r['date']
    if d not in days and r['hour']=='bmo': continue
    if r['hour']=='bmo':
        i=days.index(d) if d in days else None
        if not i: continue
        d0,d1=days[i-1],days[i]
    else:
        nxt=[x for x in days if x>d]; prv=[x for x in days if x<=d]
        if not nxt or not prv: continue
        d0,d1=prv[-1],nxt[0]
    a=ret(p,d0,d1); m=ret(sp,d0,d1)
    if a is None or m is None: continue
    eest=r['epsEstimate']; eps=(r['epsActual']-eest)/abs(eest)*100 if abs(eest)>=0.10 else None
    rev=(r['revenueActual']-r['revenueEstimate'])/r['revenueEstimate']*100
    if abs(rev)>50: continue
    recs.append(dict(sym=r['symbol'],eps=eps,rev=rev,move=(a-m)*100))
print('件数',len(recs))
allabs=st.median(abs(x['move']) for x in recs); print('値動き(S&P比)の絶対値の中央値 %.1f%%'%allabs)
def table(key,edges):
    print('\n['+key+' サプライズ]  件数 / 平均の値動き / 中央値 / 上げた割合')
    for lo,hi in edges:
        xs=[x['move'] for x in recs if x[key] is not None and lo<=x[key]<hi]
        if len(xs)<5: print(f'{lo:>6}〜{hi:<6}  {len(xs)}件'); continue
        print(f'{lo:>6}〜{hi:<6} {len(xs):4}件  平均{st.mean(xs):+5.1f}%  中央値{st.median(xs):+5.1f}%  上げ{sum(v>0 for v in xs)/len(xs)*100:4.0f}%')
I=float('inf')
table('eps',[(-I,-10),(-10,-5),(-5,-2),(-2,0),(0,2),(2,5),(5,10),(10,20),(20,I)])
table('rev',[(-I,-2),(-2,-1),(-1,-0.5),(-0.5,0),(0,0.5),(0.5,1),(1,2),(2,4),(4,I)])
print('\n[組み合わせ]')
def grp(name,f):
    xs=[x['move'] for x in recs if x['eps'] is not None and f(x)]
    if xs: print(f'{name:28} {len(xs):4}件  平均{st.mean(xs):+5.1f}%  中央値{st.median(xs):+5.1f}%  上げ{sum(v>0 for v in xs)/len(xs)*100:4.0f}%')
grp('EPS・売上とも上回る',lambda x:x['eps']>0 and x['rev']>0)
grp('EPS上回る・売上下回る',lambda x:x['eps']>0 and x['rev']<0)
grp('EPS下回る・売上上回る',lambda x:x['eps']<0 and x['rev']>0)
grp('EPS・売上とも下回る',lambda x:x['eps']<0 and x['rev']<0)
