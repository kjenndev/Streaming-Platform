import {useEffect,useRef,useState} from 'react';
import axios from 'axios';
import {API_BASE_URL} from '../config';
import {PlayerSession} from './Player';

type Context={channelName:string;displayName:string;isLive:boolean};
type Delegation={grant:string;nonce:string;parentOrigin:string;credentials:Context};
type PendingRefresh={id:string;grant:string};
const createNonce=()=>crypto.getRandomValues(new Uint32Array(6)).join('-');

export default function MssManager(){
 const [delegation,setDelegation]=useState<Delegation|null>(null),[error,setError]=useState(''),[admitted,setAdmitted]=useState(false),[watching,setWatching]=useState(false);
 const automaticRequested=useRef(false);
 const pendingWatch=useRef<string|null>(null),pendingRefresh=useRef<PendingRefresh|null>(null),delegationRef=useRef<Delegation|null>(null),authorityRef=useRef<{nonce:string;parentOrigin:string}|null>(null),terminated=useRef(false);
 const lost=(reason='Delegated access expired.')=>{if(terminated.current)return;terminated.current=true;const authority=authorityRef.current;if(authority)window.parent.postMessage({type:'mss-manager-authorization-lost',nonce:authority.nonce},authority.parentOrigin);pendingWatch.current=null;pendingRefresh.current=null;delegationRef.current=null;setWatching(false);setAdmitted(false);setDelegation(null);setError(reason)};
 useEffect(()=>{let active=true;const controller=new AbortController();let cleanup=()=>{};
  void axios.get(`${API_BASE_URL}/api/integrations/mss/config`,{signal:controller.signal}).then(({data})=>{
   if(!active||!data.enabled){setError('Stream Manager is not configured.');return}
   const nonce=createNonce();let consumed=false;authorityRef.current={nonce,parentOrigin:data.parentOrigin};
   const receive=async(event:MessageEvent)=>{
    if(terminated.current||event.origin!==data.parentOrigin||event.source!==window.parent||event.data?.nonce!==nonce)return;
    if(event.data.type==='mss-manager-stop'){automaticRequested.current=true;setWatching(false);pendingWatch.current=null;return}
    if(event.data.type==='mss-manager-watch-ack'&&pendingWatch.current===event.data.requestId){pendingWatch.current=null;setWatching(true);return}
    if(event.data.type==='mss-manager-refresh'&&typeof event.data.grant==='string'&&typeof event.data.refreshId==='string'&&delegationRef.current){
     if(event.data.channelName!==delegationRef.current.credentials.channelName)return lost('Delegated access renewal was denied.');pendingRefresh.current={id:event.data.refreshId,grant:event.data.grant};const value={...delegationRef.current,grant:event.data.grant};delegationRef.current=value;setDelegation(value);return;
    }
    if(consumed||event.data?.type!=='mss-manager-authorize'||typeof event.data.grant!=='string')return;consumed=true;
    try{const result=await axios.post(`${API_BASE_URL}/api/integrations/mss/session`,{grant:event.data.grant,channelName:event.data.channelName},{signal:controller.signal});if(active){const value={grant:event.data.grant,nonce,parentOrigin:data.parentOrigin,credentials:result.data};delegationRef.current=value;setDelegation(value)}}
    catch{if(active)lost('Delegated access was denied.')}
   };
   window.addEventListener('message',receive);cleanup=()=>window.removeEventListener('message',receive);
   window.parent.postMessage({type:'mss-manager-ready',nonce},data.parentOrigin);
  }).catch(()=>active&&setError('Stream Manager is not configured.'));
  return()=>{active=false;controller.abort();cleanup();pendingWatch.current=null;pendingRefresh.current=null;authorityRef.current=null};
 },[]);
 const admission=(ok:boolean,response?:{credentials?:{server?:string;streamKey?:string}})=>{const values=response?.credentials;const valid=ok&&delegation&&typeof values?.server==='string'&&typeof values?.streamKey==='string';setAdmitted(Boolean(valid));if(valid){window.parent.postMessage({type:'mss-manager-credentials',nonce:delegation.nonce,server:values.server,streamKey:values.streamKey,channelName:delegation.credentials.channelName},delegation.parentOrigin);if(!automaticRequested.current){automaticRequested.current=true;const requestId=createNonce();pendingWatch.current=requestId;window.parent.postMessage({type:'mss-manager-watch-request',nonce:delegation.nonce,requestId,automatic:true},delegation.parentOrigin)}}};
 const requestWatch=()=>{if(!delegation||!admitted)return;const requestId=createNonce();pendingWatch.current=requestId;window.parent.postMessage({type:'mss-manager-watch-request',nonce:delegation.nonce,requestId},delegation.parentOrigin)};
 const manager=delegation?{channelName:delegation.credentials.channelName,grant:delegation.grant,displayName:delegation.credentials.displayName,isLive:delegation.credentials.isLive,watching,onAdmission:admission,onGrantRefreshed:(grant:string)=>{const pending=pendingRefresh.current;if(!pending||pending.grant!==grant)return;pendingRefresh.current=null;window.parent.postMessage({type:'mss-manager-refresh-ack',nonce:delegation.nonce,refreshId:pending.id},delegation.parentOrigin)},onAuthorizationLost:()=>lost(),onWatch:requestWatch,onStop:()=>{pendingWatch.current=null;setWatching(false)}}:null;
 if(error)return <main role="alert" style={{padding:16,color:'#fff',background:'#111',minHeight:'100dvh'}}>{error}</main>;
 if(!delegation)return <main role="status" style={{padding:16,color:'#fff',background:'#111',minHeight:'100dvh'}}>Authorizing Stream Manager…</main>;
 return <PlayerSession manager={manager!}/>;
}
