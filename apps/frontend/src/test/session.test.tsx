import { clearIdentity, saveIdentity } from '../session';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode, useEffect } from 'react';
import axios, { AxiosError } from 'axios';
import App from '../App';
import { API_BASE_URL } from '../config';
vi.mock('../pages/Dashboard',()=>({default:function DashboardFixture(){useEffect(()=>{void axios.get(`${API_BASE_URL}/api/streams`,{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});},[]);return <p>Dashboard fixture</p>;}}));
const original=axios.defaults.adapter;
afterEach(()=>{axios.defaults.adapter=original;localStorage.clear();window.history.replaceState({},'', '/');vi.restoreAllMocks();});
function setup(status:number){
 localStorage.setItem('token','old');localStorage.setItem('username','fixture');localStorage.setItem('roles','["ADMIN"]');localStorage.setItem('role','ADMIN');localStorage.setItem('draft','keep');
 window.history.replaceState({},'', '/dashboard?sort=name');
 axios.defaults.adapter=async config=>{throw new AxiosError('fixture',undefined,config,undefined,{status,statusText:'fixture',data:{code:'SESSION_EXPIRED'},headers:{},config});};
 return render(<App/>);
}
it('expired dashboard 401 clears only identity and redirects with return target and reason',async()=>{
 setup(401);await screen.findByText(/session has expired/i);
 expect(window.location.pathname).toBe('/login');
 for(const key of ['token','username','roles','role'])expect(localStorage.getItem(key)).toBeNull();
 expect(localStorage.getItem('draft')).toBe('keep');
 expect(window.history.state.usr.returnTo).toBe('/dashboard?sort=name');
});
it.each([403,500,503])('HTTP %s does not log out a valid account',async status=>{
 setup(status);await act(async()=>{});expect(localStorage.getItem('token')).toBe('old');expect(window.location.pathname).toBe('/dashboard');
});
it('fresh login restores identity and returns to the requested protected path',async()=>{
 setup(401);await screen.findByText(/session has expired/i);
 axios.defaults.adapter=async config=>({status:200,statusText:'OK',headers:{},config,data:config.url?.endsWith('/login')?{token:'fresh',username:'fixture',roles:['CLIENT']}:[]});
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'fixture'}});
 fireEvent.change(document.querySelector('input[type="password"]')!,{target:{value:'FixtureOnly!123'}});
 fireEvent.click(screen.getByRole('button',{name:'Login'}));
 await waitFor(()=>expect(window.location.pathname).toBe('/dashboard'));
 expect(window.location.search).toBe('?sort=name');expect(localStorage.getItem('token')).toBe('fresh');expect(localStorage.getItem('roles')).toBe('["CLIENT"]');
});

it('429 shows Retry-After cooldown without repeated submissions, then allows retry',async()=>{
 window.history.replaceState({},'', '/login');
 let calls=0;
 axios.defaults.adapter=async config=>{calls++;throw new AxiosError('limited',undefined,config,undefined,{status:429,statusText:'limited',data:{error:'Too many attempts'},headers:{'retry-after':'1'},config});};
 render(<App/>);
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'fixture'}});
 fireEvent.change(document.querySelector('input[type="password"]')!,{target:{value:'FixtureOnly!123'}});
 fireEvent.click(screen.getByRole('button',{name:'Login'}));
 await screen.findByText(/Try again in 1 second/);
 expect(screen.getByRole('button',{name:'Login'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Login'}));expect(calls).toBe(1);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Login'})).not.toBeDisabled(),{timeout:2500});
 fireEvent.click(screen.getByRole('button',{name:'Login'}));await waitFor(()=>expect(calls).toBe(2));
});

it('retains an editor draft in memory across expired save and same-account reauthentication',async()=>{
 localStorage.setItem('token','draft-token');localStorage.setItem('username','fixture');
 window.history.replaceState({},'', '/dashboard/stream');
 axios.defaults.adapter=async config=>{throw new AxiosError('expired',undefined,config,undefined,{status:401,statusText:'expired',data:{},headers:{},config});};
 render(<App/>);
 fireEvent.change(screen.getAllByRole('textbox')[0],{target:{value:'unsaved-channel'}});
 fireEvent.click(screen.getByRole('button',{name:'Create Channel'}));
 await screen.findByText(/session has expired/i);
 axios.defaults.adapter=async config=>({status:200,statusText:'OK',headers:{},config,data:{token:'renewed-draft',username:'fixture',roles:['ADMIN']}});
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'fixture'}});
 fireEvent.change(document.querySelector('input[type="password"]')!,{target:{value:'FixtureOnly!123'}});
 fireEvent.click(screen.getByRole('button',{name:'Login'}));
 expect(await screen.findByDisplayValue('unsaved-channel')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 await screen.findByText('Dashboard fixture');
 await act(async()=>{window.history.pushState({},'', '/dashboard/stream');window.dispatchEvent(new PopStateEvent('popstate'));});
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
 expect(screen.queryByText('Unsaved draft restored. Review it before saving.')).not.toBeInTheDocument();
});

it.each([401,403])('public capability HTTP %s never clears account identity',async status=>{
 localStorage.setItem('token','account');
 axios.defaults.adapter=async config=>{throw new AxiosError('capability',undefined,config,undefined,{status,statusText:'denied',data:{},headers:{},config});};
 await expect(axios.post(`${API_BASE_URL}/api/public/recordings/fixture/playback`,{}, {headers:{Authorization:'Bearer account'}})).rejects.toBeDefined();
 expect(localStorage.getItem('token')).toBe('account');
});
it.each([200,401])('late HTTP %s from an older identity cannot overwrite or log out fresh login',async status=>{
 localStorage.setItem('token','old');
 let finish!:()=>void;
 axios.defaults.adapter=config=>new Promise((resolve,reject)=>{finish=()=>{const response={status,statusText:'fixture',headers:{},config,data:[]};if(status===401)reject(new AxiosError('old',undefined,config,undefined,response));else resolve(response);};});
 const pending=axios.get(`${API_BASE_URL}/api/streams`,{headers:{Authorization:'Bearer old'}});
 await Promise.resolve();localStorage.setItem('token','fresh');finish();
 await expect(pending).rejects.toBeDefined();expect(localStorage.getItem('token')).toBe('fresh');
});

it('a deliberate sign-out does not claim the session expired',async()=>{
 clearIdentity();window.history.replaceState({},'', '/settings');render(<App/>);
 await screen.findByText('Streaming Login');
 expect(screen.queryByText(/Your session has expired/)).not.toBeInTheDocument();
 expect(window.history.state.usr.returnTo).toBe('/settings');
});

it('identity changes in another tab remount protected requests under the new token',async()=>{
 setup(403);await act(async()=>{});
 const identities:string[]=[];
 axios.defaults.adapter=async config=>{identities.push(String(config.headers.get('Authorization')));return {status:200,statusText:'OK',headers:{},config,data:[]};};
 await act(async()=>{localStorage.setItem('token','replacement');window.dispatchEvent(new StorageEvent('storage',{key:'token',newValue:'replacement'}));});
 expect(identities).toContain('Bearer replacement');
});

// Recovery lifecycle: exercise the real router and account-response interceptor.
async function visitEditorRoute(path: string) {
 await act(async()=>{window.history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));});
}
function draftFixture(path='/dashboard/stream') {
 clearIdentity();
 localStorage.setItem('token','draft-fixture');localStorage.setItem('username','draft-owner');
 window.history.replaceState({},'',path);
 const state={expire:true,name:'server-original',gets:0,writes:0,account:'draft-owner'};
 axios.defaults.adapter=async config=>{
  let data: unknown=[];
  if(config.url?.endsWith('/login')) data={token:'renewed-'+state.account,username:state.account,roles:['ADMIN']};
  else if(config.method==='get') {state.gets++;data=[{id:'edit-one',channelName:state.name}];}
  else {state.writes++;if(state.expire)throw new AxiosError('expired',undefined,config,undefined,{status:401,statusText:'expired',data:{},headers:{},config});}
  return {status:200,statusText:'OK',headers:{},config,data};
 };
 render(<StrictMode><App/></StrictMode>);
 return state;
}
async function expireDraft(edit=false,value='recovered-draft') {
 if(edit) await screen.findByDisplayValue('server-original');
 fireEvent.change(screen.getAllByRole('textbox')[0],{target:{value}});
 fireEvent.click(screen.getByRole('button',{name:edit?'Update Channel':'Create Channel'}));
 await screen.findByText(/session has expired/i);
}
async function loginDraft() {
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'draft-owner'}});
 fireEvent.change(document.querySelector('input[type="password"]')!,{target:{value:'SyntheticOnly!123'}});
 fireEvent.click(screen.getByRole('button',{name:'Login'}));
 await screen.findByText(/New Channel|Edit Channel/);
}
it('recovered edit Cancel reopens with a fresh GET and latest server state',async()=>{
 const state=draftFixture('/dashboard/stream/edit-one');await expireDraft(true);await loginDraft();
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('recovered-draft');
 const before=state.gets;state.name='server-latest';
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await screen.findByText('Dashboard fixture');
 await visitEditorRoute('/dashboard/stream/edit-one');await screen.findByDisplayValue('server-latest');
 expect(state.gets).toBeGreaterThan(before);expect(screen.queryByText(/Unsaved draft restored/)).not.toBeInTheDocument();
});
it.each(['back-button','browser-back','other-route'])('recovered draft is discarded on %s rather than treated as expiry',async mode=>{
 draftFixture();await expireDraft();await loginDraft();
 if(mode==='back-button')fireEvent.click(document.querySelector('button .pi-arrow-left')!.closest('button')!);
 else if(mode==='browser-back') {await act(async()=>{window.history.back();});}
 else await visitEditorRoute('/dashboard/stream/edit-one');
 if(mode==='browser-back') await waitFor(()=>expect(window.location.pathname).not.toBe('/dashboard/stream'));
 else if(mode==='back-button') await screen.findByText('Dashboard fixture');
 else await screen.findByDisplayValue('server-original');
 await visitEditorRoute('/dashboard/stream');
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
 expect(screen.queryByText(/Unsaved draft restored/)).not.toBeInTheDocument();
});
it('a second expiry captures the latest recovered edits without persisting secrets or auto-saving',async()=>{
 const state=draftFixture();await expireDraft();await loginDraft();
 await expireDraft(false,'latest-recovered-edit');await loginDraft();
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('latest-recovered-edit');expect(state.writes).toBe(2);
 expect(Object.keys(localStorage).sort()).toEqual(['roles','token','username']);expect(sessionStorage.length).toBe(0);
});
it('successful recovered save clears recovery before reopening',async()=>{
 const state=draftFixture();await expireDraft();await loginDraft();state.expire=false;
 fireEvent.click(screen.getByRole('button',{name:'Create Channel'}));await screen.findByText('Dashboard fixture',{}, {timeout:2500});
 await visitEditorRoute('/dashboard/stream');expect(screen.getAllByRole('textbox')[0]).toHaveValue('');expect(state.writes).toBe(2);
});
it('another account cannot see a pending draft or revive it by switching back',async()=>{
 const state=draftFixture();await expireDraft();state.account='another-owner';await loginDraft();
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
 await act(async()=>{saveIdentity({token:'back-owner',username:'draft-owner',roles:['ADMIN']});});
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});
it('switching accounts away from the editor clears pending recovery permanently',async()=>{
 draftFixture();await expireDraft();
 await visitEditorRoute('/dashboard');
 await act(async()=>{saveIdentity({token:'other',username:'other-owner',roles:['ADMIN']});});
 await visitEditorRoute('/dashboard');await screen.findByText('Dashboard fixture');
 await act(async()=>{saveIdentity({token:'original-again',username:'draft-owner',roles:['ADMIN']});});
 await visitEditorRoute('/dashboard/stream');expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});
it('explicit sign-out while awaiting reauthentication discards pending recovery',async()=>{
 draftFixture();await expireDraft();await act(async()=>{clearIdentity();});await loginDraft();
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});

it('a late expired save cannot recover a draft deliberately abandoned before the response',async()=>{
 draftFixture();
 const adapter=axios.defaults.adapter as import('axios').AxiosAdapter;
 let rejectSave!:()=>void;
 axios.defaults.adapter=config=>config.method==='post' && !config.url?.endsWith('/login')
  ? new Promise((_resolve,reject)=>{rejectSave=()=>reject(new AxiosError('late expiry',undefined,config,undefined,{status:401,statusText:'expired',data:{},headers:{},config}));})
  : adapter(config);
 fireEvent.change(screen.getAllByRole('textbox')[0],{target:{value:'abandoned-pending-save'}});
 fireEvent.click(screen.getByRole('button',{name:'Create Channel'}));
 await waitFor(()=>expect(rejectSave).toBeDefined());
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await screen.findByText('Dashboard fixture');
 await act(async()=>{rejectSave();});await screen.findByText(/session has expired/i);
 axios.defaults.adapter=adapter;
 await act(async()=>{saveIdentity({token:'renewed',username:'draft-owner',roles:['ADMIN']});});
 await visitEditorRoute('/dashboard/stream');expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});

it('another-tab account switch clears pending recovery even while this tab remembers expiry',async()=>{
 draftFixture();await expireDraft();
 await act(async()=>{localStorage.setItem('username','other-tab-owner');localStorage.setItem('token','other-tab');window.dispatchEvent(new StorageEvent('storage',{key:'token',newValue:'other-tab'}));});
 await act(async()=>{saveIdentity({token:'original-again',username:'draft-owner',roles:['ADMIN']});});
 await visitEditorRoute('/dashboard/stream');expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});
it('recovery keeps channel passwords and provider keys only in memory',async()=>{
 draftFixture();
 fireEvent.click(screen.getByLabelText('Password Protected'));
 fireEvent.change(document.querySelector('input[type="password"]')!,{target:{value:'SyntheticChannelSecret'}});
 const providerKey=screen.getAllByPlaceholderText('Channel Key')[0];
 fireEvent.click(providerKey.closest('.col-12.mb-4')!.querySelector('input[type="checkbox"]')!);
 fireEvent.change(providerKey,{target:{value:'SyntheticProviderSecret'}});
 await expireDraft();await loginDraft();
 expect(document.querySelector('input[type="password"]')).toHaveValue('SyntheticChannelSecret');
 expect(screen.getAllByPlaceholderText('Channel Key')[0]).toHaveValue('SyntheticProviderSecret');
 expect(Object.keys(localStorage).sort()).toEqual(['roles','token','username']);
 expect(JSON.stringify(localStorage)).not.toContain('Synthetic');expect(sessionStorage.length).toBe(0);
});

it('independent rapid route updates before commit preserve restored state in StrictMode',async()=>{
 draftFixture();await expireDraft();await loginDraft();
 await act(async()=>{
  window.history.pushState({},'', '/dashboard/stream/edit-one');window.dispatchEvent(new PopStateEvent('popstate'));
  window.history.pushState({},'', '/dashboard/stream');window.dispatchEvent(new PopStateEvent('popstate'));
 });
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('recovered-draft');
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await screen.findByText('Dashboard fixture');
 await visitEditorRoute('/dashboard/stream');expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});
it('independent another-tab explicit logout discards pending recovery on login route',async()=>{
 draftFixture();await expireDraft();
 await act(async()=>{
  localStorage.setItem('username','draft-owner');localStorage.setItem('token','same-owner-other-tab');
  window.dispatchEvent(new StorageEvent('storage',{key:'token',newValue:'same-owner-other-tab'}));
 });
 await act(async()=>{
  localStorage.removeItem('username');localStorage.removeItem('token');localStorage.removeItem('roles');
  window.dispatchEvent(new StorageEvent('storage',{key:'token',oldValue:'same-owner-other-tab',newValue:null}));
 });
 await loginDraft();
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
});

it.each(['token-first','username-first'])('same-owner cross-tab %s recovery hand-off retains the pending draft',async order=>{
 const state=draftFixture();await expireDraft();
 const entries=order==='token-first'?[['token','other-tab-token'],['username','draft-owner']]:[['username','draft-owner'],['token','other-tab-token']];
 for(const [key,value] of entries) await act(async()=>{
  localStorage.setItem(key,value);
  window.dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage}));
 });
 expect(window.location.pathname).toBe('/login');
 await loginDraft();
 expect(screen.getAllByRole('textbox')[0]).toHaveValue('recovered-draft');
 expect(state.writes).toBe(1);
});
it.each(['token-first','username-first','clear','queued-token','queued-username','queued-switch'])('pending recovery discards remote %s even with stale expiry and later storage state',async mode=>{
 draftFixture();await expireDraft();
 await act(async()=>{
  localStorage.setItem('username','draft-owner');localStorage.setItem('token','other-tab-token');
  window.dispatchEvent(new StorageEvent('storage',{key:'token',newValue:'other-tab-token',storageArea:localStorage}));
 });
 if(mode.startsWith('queued-')) {
  // Remote writes have already advanced to the original owner again by delivery.
  await act(async()=>{
   localStorage.setItem('username','draft-owner');localStorage.setItem('token','later-other-tab-token');
   const key=mode==='queued-token'?'token':'username';
   window.dispatchEvent(new StorageEvent('storage',{key,oldValue:key==='token'?'other-tab-token':'draft-owner',newValue:mode==='queued-switch'?'different-owner':null,storageArea:localStorage}));
  });
 } else if(mode==='clear') await act(async()=>{
  localStorage.clear();window.dispatchEvent(new StorageEvent('storage',{key:null,storageArea:localStorage}));
 });
 else {
  const keys=mode==='token-first'?['token','username']:['username','token'];
  for(const key of keys) await act(async()=>{
   const oldValue=localStorage.getItem(key);localStorage.removeItem(key);
   window.dispatchEvent(new StorageEvent('storage',{key,oldValue,newValue:null,storageArea:localStorage}));
  });
 }
 expect(window.location.pathname).toBe('/login');
 await loginDraft();expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
 expect(screen.queryByText(/Unsaved draft restored/)).not.toBeInTheDocument();
});
it('unrelated storage notifications do not discard pending recovery',async()=>{
 draftFixture();await expireDraft();
 await act(async()=>{
  window.dispatchEvent(new StorageEvent('storage',{key:'roles',newValue:null,storageArea:localStorage}));
  window.dispatchEvent(new StorageEvent('storage',{key:'token',newValue:null,storageArea:sessionStorage}));
  clearIdentity('expired');
 });
 await loginDraft();expect(screen.getAllByRole('textbox')[0]).toHaveValue('recovered-draft');
});
