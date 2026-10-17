import {render,screen,waitFor,fireEvent,act} from '@testing-library/react';
import {vi,test,expect,beforeEach,afterEach} from 'vitest';
import axios from 'axios';
import MssManager from '../pages/MssManager';

vi.mock('axios');
vi.mock('../livePlayback',()=>({startLivePlayback:vi.fn(()=>Object.assign(()=>{},{resume:vi.fn()}))}));
const emit=vi.fn(),on=vi.fn(),off=vi.fn(),disconnect=vi.fn(),connect=vi.fn();
const socket={connected:true,auth:{} as Record<string,unknown>,on,off,emit,disconnect,connect};
vi.mock('socket.io-client',()=>({io:vi.fn((_url,options)=>{socket.auth=options?.auth||{};return socket})}));
beforeEach(()=>{vi.clearAllMocks();vi.mocked(axios.get).mockResolvedValue({data:{enabled:true,parentOrigin:'https://mss.example.test'}});vi.mocked(axios.post).mockResolvedValue({data:{channelName:'mapped',displayName:'Artist',isLive:true}})});
afterEach(()=>vi.useRealTimers());

test('accepts one exact-origin nonce-bound grant, derives identity, and waits for admission before automatic preview',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});
 render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-ready'}),'https://mss.example.test'));
 const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://evil.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'bad'}}));
 expect(axios.post).not.toHaveBeenCalled();
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'grant'}}));
 await screen.findByText('Signed in as Artist');expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',{channelName:'mapped',username:'Artist',password:''},expect.any(Function)));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'replay'}}));
 expect(axios.post).toHaveBeenCalledTimes(1);
});

test('waits for delegated admission and parent audio acknowledgement before starting real Player media',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});
 let joinAck:(value:{ok:boolean;cap?:string})=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;});
 render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-ready'}),'https://mss.example.test'));
 const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'grant'}}));
 await screen.findByText('Signed in as Artist');await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));await act(async()=>joinAck({ok:true,cap:'delegated-cap',credentials:{server:'rtmps://ingest.test/live',streamKey:'private-key'}} as never));
 await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-watch-request',automatic:true}), 'https://mss.example.test'));
 expect(screen.queryByRole('button',{name:'Play'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Pause'})).not.toBeInTheDocument();
 expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-watch-request',nonce}), 'https://mss.example.test');
 expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 const request=parent.postMessage.mock.calls.find(call=>call[0].type==='mss-manager-watch-request')![0];
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-watch-ack',nonce,requestId:request.requestId}}));
 expect(await screen.findByLabelText('Live stream')).toBeInTheDocument();
});

test('requires a nonempty capability before delegated admission releases credentials',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;});render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-ready'}),expect.any(String)));
 const nonce=parent.postMessage.mock.calls[0][0].nonce;fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'grant'}}));
 await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));await act(async()=>joinAck({ok:true,credentials:{server:'rtmps://ingest.test/live',streamKey:'private-key'}}));
 expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();expect(parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-credentials'}),expect.anything());
});

test('refreshes delegated socket authority in place',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{},refreshAck:(value:unknown)=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;if(name==='refresh_delegation')refreshAck=ack;});render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-ready'}),expect.any(String)));
 const nonce=parent.postMessage.mock.calls[0][0].nonce;fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'old'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));await act(async()=>joinAck({ok:true,cap:'old-cap',credentials:{server:'rtmps://ingest.test/live',streamKey:'private-key'}}));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-refresh',nonce,refreshId:'refresh-1',grant:'new',channelName:'mapped'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('refresh_delegation',{grant:'new'},expect.any(Function)));await act(async()=>refreshAck({ok:true,cap:'new-cap'}));
 expect(socket.auth).toEqual({mssGrant:'new',channelName:'mapped'});expect(parent.postMessage).toHaveBeenCalledWith({type:'mss-manager-refresh-ack',nonce,refreshId:'refresh-1'},'https://mss.example.test');expect(screen.getByText('Signed in as Artist')).toBeInTheDocument();
});

test('times out a refresh once and ignores its late success without advancing reconnect authority',async()=>{
 vi.useFakeTimers();const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{},refreshAck:(value:unknown)=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;if(name==='refresh_delegation')refreshAck=ack;});render(<MssManager/>);await act(async()=>{});const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'old'}}));await act(async()=>{});await act(async()=>joinAck({ok:true,cap:'old-cap',credentials:{server:'rtmps://ingest.test/live',streamKey:'private-key'}}));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-refresh',nonce,refreshId:'refresh-timeout',grant:'new',channelName:'mapped'}}));await act(async()=>{});expect(socket.auth).toEqual({mssGrant:'old',channelName:'mapped'});
 await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(parent.postMessage.mock.calls.filter(call=>call[0].type==='mss-manager-authorization-lost')).toHaveLength(1);
 await act(async()=>refreshAck({ok:true,cap:'late-cap'}));expect(socket.auth).toEqual({});expect(parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-refresh-ack'}),expect.anything());
});

test('does not advance reconnect authority for a denied or superseded refresh acknowledgement',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{};const refreshAcks:Array<(value:unknown)=>void>=[];
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;if(name==='refresh_delegation')refreshAcks.push(ack)});render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalled());const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'old'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));await act(async()=>joinAck({ok:true,cap:'old-cap',credentials:{server:'s',streamKey:'k'}}));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-refresh',nonce,refreshId:'a',grant:'grant-a',channelName:'mapped'}}));await waitFor(()=>expect(refreshAcks).toHaveLength(1));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-refresh',nonce,refreshId:'b',grant:'grant-b',channelName:'mapped'}}));await waitFor(()=>expect(refreshAcks).toHaveLength(2));
 await act(async()=>refreshAcks[0]({ok:true,cap:'stale'}));expect(socket.auth).toEqual({mssGrant:'old',channelName:'mapped'});
 await act(async()=>refreshAcks[1]({ok:false}));expect(socket.auth).toEqual({});expect(parent.postMessage.mock.calls.filter(call=>call[0].type==='mss-manager-authorization-lost')).toHaveLength(1);
});

test('reports initial metadata failure to the authenticated parent nonce',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});vi.mocked(axios.post).mockRejectedValueOnce(new Error('denied'));render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-ready'}),expect.any(String)));const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'bad'}}));
 await waitFor(()=>expect(parent.postMessage).toHaveBeenCalledWith({type:'mss-manager-authorization-lost',nonce},'https://mss.example.test'));
});

test('reconnects with the accepted replacement grant and rejoins once',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{},refreshAck:(value:unknown)=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;if(name==='refresh_delegation')refreshAck=ack});render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalled());const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'grant-a'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));await act(async()=>joinAck({ok:true,cap:'cap-a',credentials:{server:'s',streamKey:'k'}}));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-refresh',nonce,refreshId:'refresh-b',grant:'grant-b',channelName:'mapped'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('refresh_delegation',{grant:'grant-b'},expect.any(Function)));await act(async()=>refreshAck({ok:true,cap:'cap-b'}));
 emit.mockClear();const connectHandler=on.mock.calls.find(call=>call[0]==='connect')?.[1];expect(connectHandler).toEqual(expect.any(Function));await act(async()=>connectHandler());
 expect(socket.auth).toEqual({mssGrant:'grant-b',channelName:'mapped'});expect(emit.mock.calls.filter(call=>call[0]==='join_channel')).toHaveLength(1);
});

test('a disconnect during refresh is terminal once and its callback stays stale',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{},refreshAck:(value:unknown)=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack;if(name==='refresh_delegation')refreshAck=ack});render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalled());const nonce=parent.postMessage.mock.calls[0][0].nonce;
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-authorize',nonce,grant:'old'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));await act(async()=>joinAck({ok:true,cap:'old-cap',credentials:{server:'s',streamKey:'k'}}));
 fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{type:'mss-manager-refresh',nonce,refreshId:'refresh-new',grant:'new',channelName:'mapped'}}));await waitFor(()=>expect(emit).toHaveBeenCalledWith('refresh_delegation',expect.anything(),expect.any(Function)));
 const disconnectHandlers=on.mock.calls.filter(call=>call[0]==='disconnect').map(call=>call[1]);await act(async()=>disconnectHandlers.at(-1)());await act(async()=>refreshAck({ok:true,cap:'late'}));
 expect(parent.postMessage.mock.calls.filter(call=>call[0].type==='mss-manager-authorization-lost')).toHaveLength(1);expect(socket.auth).toEqual({});expect(parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:'mss-manager-refresh-ack'}),expect.anything());
});

test('automatic preview is muted, offline removes media, reconnect resumes, and audio stop defeats stale acknowledgements',async()=>{
 const parent={postMessage:vi.fn()};Object.defineProperty(window,'parent',{value:parent,configurable:true});let joinAck:(value:unknown)=>void=()=>{};
 emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')joinAck=ack});render(<MssManager/>);await waitFor(()=>expect(parent.postMessage).toHaveBeenCalled());const nonce=parent.postMessage.mock.calls[0][0].nonce;
 const message=(data:object)=>fireEvent(window,new MessageEvent('message',{origin:'https://mss.example.test',source:parent as unknown as MessageEventSource,data:{...data,nonce}}));
 message({type:'mss-manager-authorize',grant:'grant'});await waitFor(()=>expect(emit).toHaveBeenCalledWith('join_channel',expect.anything(),expect.any(Function)));
 const admit=()=>joinAck({ok:true,cap:'cap',credentials:{server:'s',streamKey:'mapped?key=k'}});
 await act(async()=>admit());
 const request=parent.postMessage.mock.calls.findLast(call=>call[0].type==='mss-manager-watch-request')![0];message({type:'mss-manager-watch-ack',requestId:request.requestId});
 const region=screen.getByRole('region',{name:'Video preview'}),chat=screen.getByRole('region',{name:'Chat'});
 expect((screen.getByLabelText('Live stream') as HTMLVideoElement).muted).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Unmute'}));expect((screen.getByLabelText('Live stream') as HTMLVideoElement).muted).toBe(false);
 const stats=on.mock.calls.find(call=>call[0]==='live_stats')![1];
 await act(async()=>stats({streams:{mapped:{isPublishing:false}}}));expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();expect(screen.getByText('Stream offline. Preview resumes automatically.')).toBeInTheDocument();
 await act(async()=>stats({streams:{mapped:{isPublishing:true}}}));expect((screen.getByLabelText('Live stream') as HTMLVideoElement).muted).toBe(true);
 const disconnected=on.mock.calls.find(call=>call[0]==='disconnect')![1];await act(async()=>disconnected());expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 await act(async()=>on.mock.calls.find(call=>call[0]==='connect')![1]());await act(async()=>admit());expect(screen.getByLabelText('Live stream')).toBeInTheDocument();
 message({type:'mss-manager-stop'});message({type:'mss-manager-watch-ack',requestId:request.requestId});expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 await act(async()=>stats({streams:{mapped:{isPublishing:false}}}));await act(async()=>stats({streams:{mapped:{isPublishing:true}}}));await act(async()=>admit());expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Return to preview'}));const next=parent.postMessage.mock.calls.findLast(call=>call[0].type==='mss-manager-watch-request')![0];message({type:'mss-manager-stop'});message({type:'mss-manager-watch-ack',requestId:next.requestId});expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument();
 expect(screen.getByRole('region',{name:'Video preview'})).toBe(region);expect(screen.getByRole('region',{name:'Chat'})).toBe(chat);
});
