// Browser regression check: open TK-001 with a local demo persona, then
// import this function in a Playwright runner and call page.evaluate(check).
// Uses local message fixtures and data images; restores the original messages.
export default async function checkMessageHeights() {
  if (location.hostname !== 'localhost') throw Error('Local fixture only');
  const { TICKETS } = await import('/js/core/data.js');
  const { openTicket } = await import('/js/tickets/detail.js');
  const t = TICKETS.find(t => t.id === 'TK-001');
  const original = t.msgs;
  const check = (ok, label) => { if (!ok) throw Error(label); };
  const until = async predicate => { for (let i=0;i<100;i++) { if(predicate())return; await new Promise(r=>setTimeout(r,20)); } throw Error('Timed out waiting for frame layout'); };
  const image = height => { const img=document.createElement('img');img.style.display='block';img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="'+height+'"></svg>');return img; };
  t.msgs = [
    {r:'customer',from:'Test',ts:'10:00',t:'Long email',html:Array.from({length:100},(_,i)=>'<p>Paragraph '+i+': This is a long email with enough text to wrap across several lines in a narrow reading column.</p>').join('')},
    {r:'agent',from:'Test',ts:'10:01',t:'Nested email',html:'<div style="height:80px;overflow:auto">'+Array.from({length:12},(_,i)=>'<p>Nested paragraph '+i+'</p>').join('')+'</div>'},
    {r:'customer',from:'Test',ts:'10:02',t:'Image email',html:'<p>A late image follows.</p>'}
  ];
  try {
    openTicket(t.id);
    let thread=document.querySelector('.thread');
    let frames=[...thread.querySelectorAll('.msg-frame')];
    await until(()=>frames[0].clientHeight>1200 && frames[1].clientHeight>300);
    check(frames.every(f=>f.contentDocument.documentElement.scrollHeight<=f.clientHeight+1),'An email still scrolls vertically');
    check(!frames[0].sandbox.contains('allow-scripts'),'Email scripts allowed');
    const nested=frames[1].contentDocument.body.firstElementChild;
    check(nested.scrollHeight<=nested.clientHeight+1,'Nested scroll box did not expand');
    const wide=frames[0].clientHeight;
    thread.style.width='360px';
    await until(()=>frames[0].clientHeight>wide+100);
    thread.style.removeProperty('width');
    await until(()=>Math.abs(frames[0].clientHeight-wide)<=1);
    const anchor=thread.children[1];
    thread.scrollTop+=anchor.getBoundingClientRect().top-thread.getBoundingClientRect().top+20;
    thread.dispatchEvent(new WheelEvent('wheel'));
    const anchorTop=anchor.getBoundingClientRect().top;
    frames[0].contentDocument.body.appendChild(image(400));
    await until(()=>frames[0].clientHeight>wide+300);
    check(Math.abs(anchor.getBoundingClientRect().top-anchorTop)<2,'Earlier image moved the reader');
    const position=thread.scrollTop;
    const short=frames[2].clientHeight;
    frames[2].contentDocument.body.appendChild(image(500));
    await until(()=>frames[2].clientHeight>short+400);
    check(Math.abs(thread.scrollTop-position)<2,'Later image moved the reader');
    thread.scrollTop=thread.scrollHeight;
    const previous=frames[2].clientHeight;
    frames[2].contentDocument.body.appendChild(image(300));
    await until(()=>frames[2].clientHeight>previous+200);
    check(thread.scrollHeight-thread.clientHeight-thread.scrollTop<2,'Newest message no longer pinned');
    thread.scrollTop=1500;
    openTicket(t.id);
    thread=document.querySelector('.thread');
    await until(()=>thread.querySelector('.msg-frame').clientHeight>1200);
    await until(()=>Math.abs(thread.scrollTop-1500)<2);
    return {passed:true,longEmailHeight:wide,checks:['full height','no nested vertical scrolling','sandbox retained','narrow growth','wide shrink','reader anchor','late image','bottom pin','rerender scroll']};
  } finally { t.msgs=original;openTicket(t.id); }
}

