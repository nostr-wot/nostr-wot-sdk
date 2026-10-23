import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools';
import type { NostrSigner } from './types';

/** Independently implemented client for Nosskey's documented postMessage protocol.
 * The provider owns consent and keys; this client pins the frame, origin and account.
 */
export class NosskeyIframeSigner implements NostrSigner {
  readonly iframe: HTMLIFrameElement;
  readonly #origin: string;
  readonly #timeout: number;
  readonly #ready: Promise<void>;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  #readyTimer: ReturnType<typeof setTimeout>;
  #closed = false;
  #pubkey?: string;
  #loaded = false;
  #pending = new Map<string, {resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>}>();

  constructor(options: { iframeUrl: string; container?: HTMLElement; timeoutMs?: number }) {
    const url = new URL(options.iframeUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Signer URL must use HTTPS without credentials');
    this.#origin = url.origin;
    this.#timeout = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.#timeout) || this.#timeout < 1 || this.#timeout > 120_000) throw new Error('Invalid signer timeout');
    this.#ready = new Promise((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject;});
    void this.#ready.catch(()=>{});
    this.iframe = document.createElement('iframe');
    this.iframe.setAttribute('allow','publickey-credentials-get; publickey-credentials-create');
    this.iframe.setAttribute('title','Passkey signing provider');
    this.iframe.setAttribute('aria-hidden','true');
    Object.assign(this.iframe.style,{display:'none',position:'fixed',inset:'10% 5%',width:'90%',height:'80%',zIndex:'2147483647',border:'0',borderRadius:'16px'});
    window.addEventListener('message',this.#receive);
    this.iframe.addEventListener('load',()=>{if(this.#loaded)this.close();this.#loaded=true;});
    this.#readyTimer = setTimeout(()=>this.#shutdown(new Error('Signer connection timed out')),this.#timeout);
    this.iframe.src=url.href;
    (options.container ?? document.body).appendChild(this.iframe);
  }
  ready(): Promise<void> { return this.#closed ? Promise.reject(new Error('Signer connection closed')) : this.#ready; }
  #receive = (event: MessageEvent) => {
    if (this.#closed || event.origin !== this.#origin || event.source !== this.iframe.contentWindow) return;
    const d=event.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return;
    if(d.type==='nosskey:ready'){clearTimeout(this.#readyTimer);this.#readyResolve();return;}
    if(d.type==='nosskey:visibility' && typeof d.visible==='boolean'){
      this.iframe.style.display=d.visible?'block':'none';
      this.iframe.setAttribute('aria-hidden',String(!d.visible));return;
    }
    if(d.type!=='nosskey:response' || typeof d.id!=='string')return;
    const pending=this.#pending.get(d.id);if(!pending)return;
    this.#pending.delete(d.id);clearTimeout(pending.timer);
    if(d.error!==undefined){pending.reject(new Error(typeof d.error?.message==='string'?d.error.message:'Signer request failed'));return;}
    if(!Object.prototype.hasOwnProperty.call(d,'result')){pending.reject(new Error('Invalid signer response'));return;}
    pending.resolve(d.result);
  };
  async #request(method:string,params?:Record<string,unknown>): Promise<unknown> {
    await this.ready();
    if(this.#closed)throw new Error('Signer connection closed');
    if(this.#pending.size>=8)throw new Error('Too many pending signer requests');
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.#shutdown(new Error('Signer request timed out')),this.#timeout);
      this.#pending.set(id,{resolve,reject,timer});
      try {
        if(!this.iframe.contentWindow)throw new Error('Signer frame unavailable');
        this.iframe.contentWindow.postMessage({type:'nosskey:request',id,method,...(params?{params}:{})},this.#origin);
      } catch(error){clearTimeout(timer);this.#pending.delete(id);reject(error);}
    });
  }
  async getPublicKey(): Promise<string> {
    const result=await this.#request('getPublicKey');
    if(typeof result!=='string'||!/^[a-f0-9]{64}$/.test(result))throw new Error('Invalid signer public key');
    if(this.#pubkey && this.#pubkey!==result){this.close();throw new Error('Signer account changed');}
    return this.#pubkey=result;
  }
  async signEvent(template:EventTemplate): Promise<Event> {
    const expected=JSON.stringify([template.kind,template.created_at,template.tags,template.content]);
    const pubkey=this.#pubkey ?? await this.getPublicKey();
    const result=await this.#request('signEvent',{event:template}) as Event;
    // A plain copy avoids trusting nostr-tools' cached verification symbol on a caller object.
    const event=result && {id:result.id,pubkey:result.pubkey,sig:result.sig,kind:result.kind,created_at:result.created_at,tags:result.tags,content:result.content};
    if(!event || event.pubkey!==pubkey || JSON.stringify([event.kind,event.created_at,event.tags,event.content])!==expected || !verifyEvent(event))throw new Error('Signed event does not match the requested event');
    return event;
  }
  async #crypt(method:string,pubkey:string,value:string):Promise<string>{
    await this.getPublicKey();
    const result=await this.#request(method,{pubkey,[method.endsWith('encrypt')?'plaintext':'ciphertext']:value});
    if(typeof result!=='string')throw new Error('Invalid signer encryption response');return result;
  }
  nip04Encrypt(pubkey:string,value:string){return this.#crypt('nip04_encrypt',pubkey,value);}
  nip04Decrypt(pubkey:string,value:string){return this.#crypt('nip04_decrypt',pubkey,value);}
  nip44Encrypt(pubkey:string,value:string,opts?:{scheme:'pq';recipientKemKey:string}){if(opts)return Promise.reject(new Error('Post-quantum encryption is not supported by this provider'));return this.#crypt('nip44_encrypt',pubkey,value);}
  nip44Decrypt(pubkey:string,value:string){return this.#crypt('nip44_decrypt',pubkey,value);}
  #shutdown(error:Error){
    if(this.#closed)return;this.#closed=true;clearTimeout(this.#readyTimer);this.#readyReject(error);
    for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(error);}this.#pending.clear();
    window.removeEventListener('message',this.#receive);this.iframe.remove();
  }
  close(){this.#shutdown(new Error('Signer connection closed'));}
}
