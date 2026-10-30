'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const {SplatTaskStore,UUID} = require('./splatTaskStore');
const {SplatError,fail,canonical,hash,same,validateRequest,verifyGrant} = require('./splatAuth');
const {workerRequest} = require('./splatNetwork');

const defaults = {
    enabled:false, profileId:'nodesplat-v1', instanceId:'', storeDir:'data/splat-tasks',
    maxConcurrentRuns:1, maxLogBytes:52428800, maxPageLines:500, maxPageBytes:262144,
    maxResultBytes:8*1024*1024*1024, grantMaxAgeSeconds:300, workerLeaseSeconds:86400,
    grantKeys:{}, profile:{}
};
const TERMINAL = new Set(['ready','failed','canceled']);
const random = () => crypto.randomBytes(32).toString('base64url');
const uuid = () => require('uuid/v4')();
const reply = (res,status,body) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); };
async function readBody(req) {
    const chunks=[]; let bytes=0;
    for await(const chunk of req) {
        bytes+=chunk.length;
        if(bytes>32768) fail(413,'body_limit','Training request is too large.');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch(_) { fail(400,'invalid_json','Expected a JSON request.'); }
}
function regularFile(root,runId,name,maximum) {
    const absoluteRoot=fs.realpathSync(root);
    const directory=path.join(absoluteRoot,runId);
    if(fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) fail(409,'artifact_invalid','Training artifact is invalid.');
    const file=path.join(directory,name);
    const stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>maximum || fs.realpathSync(file)!==file) fail(409,'artifact_invalid','Training artifact is invalid.');
    return {file,stat};
}
const shaFile = file => new Promise((resolve,reject) => {
    const digest=crypto.createHash('sha256'); const stream=fs.createReadStream(file);
    stream.on('data',chunk=>digest.update(chunk)); stream.on('error',reject); stream.on('end',()=>resolve(digest.digest('hex')));
});

class SplatTasks {
    constructor(options={}, dependencies={}) {
        this.config=Object.assign({},defaults,options);
        this.profile=this.config.profile;
        this.api=dependencies.api || ((token) => axios.create({baseURL:this.profile.baseUrl,timeout:60000,maxRedirects:0,headers:{'X-Tapis-Token':token}}));
        this.requestWorker=dependencies.workerRequest || workerRequest;
        // Same secret NodeODX workers register with; resolved lazily so config reloads are honored.
        this.registrationSecret=dependencies.registrationSecret || (() => this.config.registrationSecret || '');
        this.sessions=new Map();
        this.operations=new Map();
        if(this.config.enabled) {
            const required=['baseUrl','tenantId','appId','appVersion','executionSystemId','archiveSystemId','queue','allocation','coresPerNode','memoryMB','maxMinutes','inputRoot','outputRoot','callbackUrl','workerBindHost','workerPort'];
            if(!this.config.instanceId || required.some(key=>!this.profile[key]) || this.profile.maxMinutes*60+600>this.config.workerLeaseSeconds) throw new Error('Incomplete NodeSplat fixed profile');
            const base=new URL(this.profile.baseUrl);
            if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash) throw new Error('Unsafe NodeSplat Tapis base URL');
            this.store=dependencies.store || new SplatTaskStore(this.config.storeDir);
        }
    }
    close() { if(this.store) this.store.close(); }
    async owner(token) {
        if(!token) fail(401,'signin_required','Please sign in again.');
        let claims;
        try { claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')); } catch(_) { fail(401,'signin_required','Please sign in again.'); }
        const username=claims['tapis/username'],tenant=claims['tapis/tenant_id'];
        if(typeof username!=='string' || !/^[\x21-\x7e]+$/.test(username) || tenant!==this.profile.tenantId || !Number.isFinite(claims.exp) || claims.exp<=Date.now()/1000) fail(401,'signin_required','Please sign in again.');
        try { await this.api(token).get('/v3/systems'); }
        catch(error) {
            const status=error.response && error.response.status;
            if(status===401) fail(401,'signin_required','Tapis rejected your session. Please sign in again.');
            if(status===403) fail(403,'tapis_forbidden','Tapis does not permit this operation.');
            fail(503,'auth_unavailable','Cannot validate your Tapis session.');
        }
        return {username,tenant};
    }
    owned(id,owner) {
        if(!UUID.test(id || '')) fail(404,'not_found','Training attempt was not found.');
        const record=this.store.get(id);
        if(!record) fail(404,'not_found','Training attempt was not found.');
        if(record.owner.username!==owner.username || record.owner.tenant!==owner.tenant) fail(403,'not_owner','This training attempt belongs to another user.');
        return record;
    }
    view(r) {
        return {uuid:r.uuid,run_id:r.run_id,state:r.state,phase:r.phase,worker_status:r.worker_status||null,progress:r.progress||null,cancel_pending:!!r.cancel_pending,tapis_job_uuid:r.tapis_job_uuid||null,error:r.error||null,updated_at:r.updated_at};
    }
    save(r) { return this.store.save(r); }
    async serialize(id,operation) {
        const previous=this.operations.get(id)||Promise.resolve();
        const current=previous.catch(()=>{}).then(operation);
        this.operations.set(id,current);
        try { return await current; } finally { if(this.operations.get(id)===current) this.operations.delete(id); }
    }
    buildJob(r,api,secret) {
        const p=this.profile;
        const env={NODESPLAT_ENABLED:'YES',NODESPLAT_LEASE_DEADLINE:String(Math.floor(r.lease_expires_at/1000)),NODESPLAT_RUN_ID:r.run_id,NODESPLAT_CLUSTER_TASK_ID:r.uuid,NODESPLAT_PROFILE_ID:r.profile_id,NODESPLAT_INPUT_ROOT:p.workerInputRoot||p.inputRoot,NODESPLAT_OUTPUT_ROOT:p.workerOutputRoot||p.outputRoot,NODESPLAT_CALLBACK_URL:p.callbackUrl,NODESPLAT_REGISTRATION_SECRET:secret,NODESPLAT_API_CAPABILITY:api,NODESPLAT_BIND_HOST:p.workerBindHost,NODESPLAT_PORT:String(p.workerPort),NODESPLAT_APP_ID:p.appId,NODESPLAT_APP_VERSION:p.appVersion};
        return {name:r.job_name,appId:p.appId,appVersion:p.appVersion,execSystemId:p.executionSystemId,execSystemLogicalQueue:p.queue,archiveSystemId:p.archiveSystemId,nodeCount:1,coresPerNode:p.coresPerNode,memoryMB:p.memoryMB,maxMinutes:p.maxMinutes,archiveOnAppError:true,parameterSet:{appArgs:p.appArgs||[],envVariables:Object.keys(env).map(key=>({key,value:env[key]})),schedulerOptions:[{name:'TACC Allocation',arg:`-A ${p.allocation}`}]}};
    }
    async create(body,owner,token) {
        const requestHash=validateRequest(body,this.config);
        const existing=this.store.all().find(r=>r.run_id===body.run_id);
        if(existing) {
            this.owned(existing.uuid,owner);
            if(existing.request_hash!==requestHash) fail(409,'replay_conflict','Training attempt already has different inputs.');
            verifyGrant(body.grant,body,owner,this.config,true);
            return {status:200,record:existing};
        }
        const grantHash=verifyGrant(body.grant,body,owner,this.config);
        if(this.store.all().filter(r=>!TERMINAL.has(r.state)).length>=this.config.maxConcurrentRuns) fail(429,'capacity','The GPU training profile is busy.');
        // Authenticate before opening inputs; a valid grant is bound to this manifest.
        const input=regularFile(this.profile.inputRoot,body.run_id,'input/webodm-input.json',64*1024*1024);
        if(await shaFile(input.file)!==body.manifest_sha256) fail(409,'input_changed','Training inputs changed.');
        // Recheck after async hashing so concurrent create requests cannot exceed capacity.
        if(this.store.all().some(r=>r.run_id===body.run_id)) return this.create(body,owner,token);
        if(this.store.all().filter(r=>!TERMINAL.has(r.state)).length>=this.config.maxConcurrentRuns) fail(429,'capacity','The GPU training profile is busy.');
        const registrationSecret=this.registrationSecret();
        if(typeof registrationSecret!=='string' || !registrationSecret) fail(503,'unavailable','Training service is temporarily unavailable.');
        const api=random();
        const r={version:1,uuid:uuid(),owner,run_id:body.run_id,source_task_id:body.source_task_id,manifest_sha256:body.manifest_sha256,profile_id:body.profile_id,settings:body.settings,request_hash:requestHash,grant_hash:grantHash,state:'submitting',phase:'Submitting GPU worker',tapis_job_uuid:null,cancel_pending:false,api_hash:hash(api),lease_expires_at:Date.now()+this.config.workerLeaseSeconds*1000};
        r.job_name=`nodesplat-${r.uuid}`;
        this.save(r);
        try {
            const response=await this.api(token).post('/v3/jobs/submit',this.buildJob(r,api,registrationSecret));
            const result=response.data && response.data.result;
            if(!result || !result.uuid) throw new Error('Uncertain Tapis response');
            r.tapis_job_uuid=result.uuid;
            r.state=r.cancel_pending?'cancel_pending':'queued';
            r.phase=r.cancel_pending?'Stopping GPU worker':'Waiting for GPU worker';
        } catch(error) {
            const status=error.response && error.response.status;
            if(status && status<500) {
                r.state='failed'; r.phase='Submission rejected';
                r.error={code:status===401?'signin_required':status===403?'tapis_forbidden':'submission_rejected',message:status===401?'Tapis rejected your session. Please sign in again.':status===403?'Tapis denied access to the GPU app or system.':`Tapis rejected the job (HTTP ${status}).`};
                r.revoked=true;
            } else { r.state=r.cancel_pending?'cancel_pending':'submission_unknown'; r.phase='Checking whether Tapis accepted the worker'; }
        }
        this.save(r);
        return {status:202,record:r};
    }
    // NodeODX-style webhook registration (adminweb /webhook/register-node, role "nodesplat").
    // Authenticated by the shared registration secret and bound to one exact pending task/job.
    // It is an idempotent keepalive: a ClusterODX restart drops the in-memory worker token and
    // the next registration restores it. Never touches the generic node registry.
    async registerWorker(reg) {
        if(!this.config.enabled) fail(404,'disabled','NodeSplat training is disabled.');
        const secret=this.registrationSecret();
        if(!secret || typeof reg.registrationSecret!=='string' || !reg.registrationSecret || !same(hash(secret),hash(reg.registrationSecret))) fail(401,'invalid_registration','Worker registration secret is invalid.');
        const token=typeof reg.nodeToken==='string'?reg.nodeToken:'';
        const denied=()=>fail(403,'invalid_registration','Worker registration is not authorized.');
        if(!UUID.test(reg.registrationUuid||'')) denied();
        return this.serialize(reg.registrationUuid,async()=>{
            const r=this.store.get(reg.registrationUuid);
            if(!r) denied();
            if(!r.tapis_job_uuid) fail(409,'job_not_bound','The GPU job is not recorded yet; retry registration.');
            if(typeof reg.tapisJobUuid!=='string' || reg.tapisJobUuid!==r.tapis_job_uuid || r.revoked || r.lease_expires_at<Date.now() || TERMINAL.has(r.state) || !token || !same(hash(token),r.api_hash)) denied();
            if(!/^[A-Za-z0-9.-]{1,253}$/.test(reg.hostname||'') || !Number.isInteger(reg.port) || reg.port<1 || reg.port>65535) fail(400,'invalid_registration','Invalid worker address.');
            const url=`http://${reg.hostname}:${reg.port}/`;
            if(r.worker_url && r.worker_url!==url) fail(409,'worker_conflict','Worker identity cannot change.');
            this.sessions.set(r.uuid,token);
            if(r.worker_started) return {success:true,uuid:r.uuid};
            const info=await this.requestWorker(url,'/info',token);
            if(info.engine!=='nodesplat' || !Array.isArray(info.capabilities) || !info.capabilities.includes('opensplat-webodm-v1')) fail(409,'worker_capability','Worker does not support this training profile.');
            r.worker_url=url; r.last_heartbeat=Date.now(); this.save(r);
            const result=await this.requestWorker(url,'/task/new',token,'POST',{run_id:r.run_id,source_task_id:r.source_task_id,manifest_sha256:r.manifest_sha256,settings:r.settings,'set-uuid':r.uuid});
            if(result.uuid!==r.uuid) fail(409,'worker_identity','Worker task identity does not match.');
            r.worker_started=true;
            if(!TERMINAL.has(r.state) && r.state!=='cancel_pending' && r.state!=='result_ready') { r.state='running'; r.phase='Preparing training inputs'; }
            this.save(r);
            return {success:true,uuid:r.uuid};
        });
    }
    async verifyArtifacts(r) {
        const manifest=regularFile(this.profile.outputRoot,r.run_id,'manifest.json',1024*1024);
        const ply=regularFile(this.profile.outputRoot,r.run_id,'model.ply',this.config.maxResultBytes);
        const m=JSON.parse(fs.readFileSync(manifest.file,'utf8'));
        if(m.run_id!==r.run_id || m.source_task_id!==r.source_task_id || m.cluster_task_uuid!==r.uuid || m.tapis_job_uuid!==r.tapis_job_uuid || m.profile_id!==r.profile_id || !m.app || m.app.id!==this.profile.appId || m.app.version!==this.profile.appVersion || canonical(m.settings)!==canonical(r.settings) || !m.output || m.output.bytes!==ply.stat.size || ply.stat.size===0 || m.output.sha256!==await shaFile(ply.file)) fail(409,'artifact_invalid','Training artifacts failed verification.');
        return m;
    }
    // Owner-synced polling replaces worker heartbeats. A failed poll is only a stale signal.
    async pollWorker(r) {
        const token=this.sessions.get(r.uuid);
        if(!r.worker_url || !token || r.revoked) return;
        let info=null;
        try { info=await this.requestWorker(r.worker_url,`/task/${r.uuid}/info`,token); } catch(_) { /* worker may be starting or gone */ }
        if(info && typeof info==='object') {
            r.last_heartbeat=Date.now();
            const code=info.status && info.status.code;
            if(Number.isInteger(code)) r.worker_status=code;
            if(typeof info.phase==='string' && r.state!=='result_ready') r.phase=info.phase.replace(/[\r\n]/g,' ').slice(0,120);
            const p=info.progress;
            if(p && Number.isInteger(p.iteration) && Number.isInteger(p.total) && p.iteration>=0 && p.total===r.settings.num_iterations && p.iteration<=p.total) r.progress={iteration:p.iteration,total:p.total};
            if(info.result_ready===true && !r.cancel_pending && r.state!=='result_ready') {
                try {
                    await this.verifyArtifacts(r);
                    r.state='result_ready'; r.phase='Training complete; releasing GPU worker'; r.ack_pending=true;
                } catch(_) { r.phase='Training artifacts failed verification'; }
            } else if(code===30 || code===50) {
                r.worker_terminal=code===30?'failed':'canceled';
                r.phase=code===30?'Worker failed; checking allocation':'Worker stopped; checking allocation';
                r.ack_pending=true;
            }
            this.save(r);
        }
        if(r.ack_pending) {
            // Best effort, retried by later syncs while the worker session exists.
            try { await this.requestWorker(r.worker_url,'/task/remove',token,'POST',{uuid:r.uuid}); r.ack_pending=false; this.save(r); } catch(_) { /* retry on next sync */ }
        }
    }
    async reconcile(r,token) {
        if(TERMINAL.has(r.state)) return r;
        await this.pollWorker(r);
        let job;
        try {
            if(!r.tapis_job_uuid) {
                const response=await this.api(token).get('/v3/jobs/search',{params:{search:`name.eq.${r.job_name}`}});
                const jobs=(response.data.result||[]).filter(j=>j.name===r.job_name && j.appId===this.profile.appId && j.appVersion===this.profile.appVersion && (!j.owner || j.owner===r.owner.username));
                if(jobs.length!==1) { r.phase=jobs.length?'Multiple GPU jobs found; administrator review required':'No accepted GPU job found; administrator review required'; this.save(r); return r; }
                job=jobs[0]; r.tapis_job_uuid=job.uuid; this.save(r);
            } else { const response=await this.api(token).get(`/v3/jobs/${encodeURIComponent(r.tapis_job_uuid)}`); job=response.data.result; }
        } catch(error) {
            const status=error.response && error.response.status;
            fail(status===401?401:status===403?403:503,status===401?'signin_required':'reconcile_unavailable',status===401?'Please sign in again.':'Cannot reconcile the GPU allocation.');
        }
        if(!job || job.name!==r.job_name || job.appId!==this.profile.appId || job.appVersion!==this.profile.appVersion || (job.owner && job.owner!==r.owner.username)) fail(409,'job_identity','GPU job identity does not match this attempt.');
        const state=job.status;
        if(['FINISHED','FAILED','CANCELLED','CANCELED'].includes(state)) {
            if(r.cancel_pending || state==='CANCELLED' || state==='CANCELED') { r.state='canceled'; r.phase='Canceled'; }
            else if(state==='FINISHED' && r.worker_terminal!=='failed') { await this.verifyArtifacts(r); r.state='ready'; r.phase='Training artifacts ready'; }
            else { r.state='failed'; r.phase='GPU worker failed'; r.error={code:'training_failed',message:'The GPU training worker failed. Inspect its console output.'}; }
            r.cancel_pending=false; r.revoked=true; this.sessions.delete(r.uuid);
        } else if(r.cancel_pending) { await this.stop(r,token); }
        else if(r.state!=='result_ready') { r.state=state==='RUNNING'?'running':'queued'; r.phase=r.worker_url?r.phase:'Waiting for GPU worker'; }
        this.save(r); return r;
    }
    async stop(r,token) {
        const api=this.sessions.get(r.uuid);
        if(r.worker_url && api) {
            try { await this.requestWorker(r.worker_url,'/task/cancel',api,'POST',{uuid:r.uuid}); } catch(_) { /* Scheduler stop remains authoritative. */ }
        }
        if(r.tapis_job_uuid) {
            try { await this.api(token).put(`/v3/jobs/${encodeURIComponent(r.tapis_job_uuid)}`,{operation:'stop'}); }
            catch(error) { if(error.response && error.response.status===401) fail(401,'signin_required','Cancellation is pending; please sign in again.'); }
        }
    }
    async cancel(r,token) {
        if(TERMINAL.has(r.state)) return r;
        r.cancel_pending=true; r.state='cancel_pending'; r.phase='Stopping GPU worker'; this.save(r);
        await this.stop(r,token); return r;
    }
    output(r,line) {
        if(!/^\d+$/.test(String(line)) || !Number.isSafeInteger(Number(line))) fail(400,'invalid_cursor','Invalid console line offset.');
        line=Number(line);
        let text='';
        try { const value=regularFile(this.profile.outputRoot,r.run_id,'console.txt',this.config.maxLogBytes+4096); text=fs.readFileSync(value.file,'utf8'); }
        catch(error) { if(error.code!=='ENOENT') throw error; }
        const all=text.split('\n'); if(all[all.length-1]==='') all.pop();
        const lines=[]; let bytes=0;
        for(const value of all.slice(line,line+this.config.maxPageLines)) { const size=Buffer.byteLength(value)+1; if(bytes+size>this.config.maxPageBytes) break; lines.push(value); bytes+=size; }
        return {uuid:r.uuid,lines,from_line:line,next_line:line+lines.length,truncated:Buffer.byteLength(text)>=this.config.maxLogBytes,eof:TERMINAL.has(r.state)&&line+lines.length>=all.length};
    }
    async handle(req,res) {
        const url=new URL(req.url,'http://cluster.invalid');
        if(!url.pathname.startsWith('/splat/')) return false;
        try {
            if(!this.config.enabled) fail(503,'disabled','NodeSplat training is disabled.');
            const match=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'');
            const token=match&&match[1];
            const owner=await this.owner(token);
            if(req.method==='POST' && url.pathname==='/splat/task/new') {
                const result=await this.create(await readBody(req),owner,token);
                reply(res,result.status,this.view(result.record)); return true;
            }
            if(req.method==='POST' && url.pathname==='/splat/task/cancel') {
                const body=await readBody(req); const r=this.owned(body.uuid,owner);
                const result=await this.serialize(r.uuid,()=>this.cancel(r,token));
                reply(res,result.cancel_pending?202:200,this.view(result)); return true;
            }
            const route=/^\/splat\/task\/([^/]+)\/(info|sync|output|download\/(model\.ply|manifest\.json|console\.txt))$/.exec(url.pathname);
            if(!route) fail(404,'not_found','Training endpoint was not found.');
            const r=this.owned(route[1],owner);
            if(route[2]==='sync' && req.method==='POST') { const value=await this.serialize(r.uuid,()=>this.reconcile(r,token)); reply(res,200,this.view(value)); }
            else if(route[2]==='info' && req.method==='GET') reply(res,200,this.view(r));
            else if(route[2]==='output' && req.method==='GET') reply(res,200,this.output(r,url.searchParams.get('line')||'0'));
            else if(route[3] && req.method==='GET') {
                if(route[3]!=='console.txt' && r.state!=='ready') fail(409,'not_ready','Training artifacts are not ready.');
                const item=regularFile(this.profile.outputRoot,r.run_id,route[3],route[3]==='console.txt'?this.config.maxLogBytes+4096:this.config.maxResultBytes);
                res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':item.stat.size,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="${route[3]}"`});
                fs.createReadStream(item.file).on('error',()=>res.destroy()).pipe(res);
            } else fail(405,'method_not_allowed','Unsupported request method.');
        } catch(error) {
            const safe=error instanceof SplatError?error:new SplatError(503,'unavailable','Training service is temporarily unavailable.');
            reply(res,safe.status,{error:{code:safe.code,message:safe.message},uuid:null});
        }
        return true;
    }
}
module.exports={SplatTasks,defaults,regularFile};
