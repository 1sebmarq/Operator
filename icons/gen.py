from PIL import Image, ImageDraw

BG=(11,14,20,255); BG2=(27,34,51,255); ACC=(91,140,255,255); GOOD=(54,211,154,255)

def icon(size, maskable=False):
    img=Image.new('RGBA',(size,size),(0,0,0,0))
    d=ImageDraw.Draw(img)
    pad = int(size*0.0) if maskable else int(size*0.06)
    r=int(size*0.22)
    # background panel (full bleed for maskable so safe-zone is respected)
    if maskable:
        d.rectangle([0,0,size,size],fill=BG)
    else:
        d.rounded_rectangle([pad,pad,size-pad,size-pad],radius=r,fill=BG)
    cx=size/2; cy=size*0.54
    # headband arc
    band_w=int(size*0.045)
    bbox=[size*0.22,size*0.30,size*0.78,size*0.78]
    d.arc(bbox,start=200,end=340,fill=ACC,width=band_w)
    # electrode dots along arc
    import math
    dot_r=int(size*0.045)
    for ang,col in [(205,ACC),(250,GOOD),(290,GOOD),(335,ACC)]:
        a=math.radians(ang)
        ex=(bbox[0]+bbox[2])/2 + (bbox[2]-bbox[0])/2*math.cos(a)
        ey=(bbox[1]+bbox[3])/2 + (bbox[3]-bbox[1])/2*math.sin(a)
        d.ellipse([ex-dot_r,ey-dot_r,ex+dot_r,ey+dot_r],fill=col)
    # waveform line
    import random
    y0=int(size*0.30)
    pts=[]
    n=24
    amp=size*0.05
    for i in range(n+1):
        x=size*0.26 + (size*0.48)*i/n
        y=y0 + amp*math.sin(i*0.9)*(0.4+0.6*math.sin(i*0.37))
        pts.append((x,y))
    d.line(pts,fill=GOOD,width=max(2,int(size*0.012)))
    return img

icon(192).save('icon-192.png')
icon(512).save('icon-512.png')
icon(512,maskable=True).save('icon-maskable-512.png')
print('icons written')
