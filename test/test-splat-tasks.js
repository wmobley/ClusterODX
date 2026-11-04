'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {Readable}=require('stream');
const {SplatTasks}=require('../libs/splatTasks');
const {SplatTaskStore}=require('../libs/splatTaskStore');
const {canonical,hash}=require('../libs/splatAuth');
const {parseWorkerUrl}=require('../libs/splatNetwork');
const uuid=require('uuid/v4');

const secret='test-only-32-byte-secret-material-for-signatures';
function token(username='operator') {
    return 'header.'+Buffer.from(JSON.stringify({'tapis/username':username,'tapis/tenant_id':'portals',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature';
}
function grant(body,username='operator',expired=false) {
    const now=Math.floor(Date.now()/1000)-(expired?600:0);
    const unsigned={version:1,key_id:'test',payload:{issuer:'webodm',audience:'test-cluster',run_id:body.run_id,source_task_id:body.source_task_id,owner:{username,tenant:'portals'},manifest_sha256:body.manifest_sha256,settings:body.settings,issued_at:now,expires_at:now+300}};
    return Object.assign({},unsigned,{signature:crypto.createHmac('sha256',secret).update(canonical(unsigned)).digest('base64url')});
}
async function call(service,method,url,body,bearer=token()) {
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    req.method=method; req.url=url; req.headers={authorization:`Bearer ${bearer}`};
    let status,result;
    const res={writeHead(code){status=code;},end(data){result=JSON.parse(data);}};
    assert.strictEqual(await service.handle(req,res),true);
    return {status,body:result};
}
const REG_SECRET='shared-registration-secret';
const HOST='c301-001.ls6.tacc.utexas.edu';
(async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluster-splat-'));
    const inputRoot=path.join(root,'input'),outputRoot=path.join(root,'output');
    fs.mkdirSync(inputRoot);fs.mkdirSync(outputRoot);
    const profile={baseUrl:'https://example.tapis.invalid',tenantId:'portals',appId:'nodesplat-ls6',appVersion:'0.1.0',executionSystemId:'ls6',archiveSystemId:'cloud.data',queue:'gpu-test',allocation:'TEST',coresPerNode:1,memoryMB:4096,maxMinutes:10,inputRoot,outputRoot,callbackUrl:'https://cluster.invalid',workerBindHost:'0.0.0.0',workerPort:4444};
    // A leftover callbackPolicy from an older config file is tolerated and ignored.
    const config={enabled:true,instanceId:'test-cluster',storeDir:path.join(root,'store'),grantKeys:{webodm:{test:secret}},callbackPolicy:{schemes:[],hosts:[],cidrs:[],ports:[]},profile};
    let rejectBody=null,submissions=0,stops=0,jobStatus='RUNNING',job,env,newCalls=0,removeCalls=0,removeFails=false,failSubmit=false,workerInfo=null;
    const api=()=>({get:async url=> {
        if(url==='/v3/systems') return {data:{result:[]}};
        if(url==='/v3/jobs/search') return {data:{result:job?[job]:[]}};
        return {data:{result:Object.assign({},job,{status:jobStatus})}};
    },post:async (_url,spec)=> {
        if(failSubmit) { const error=new Error('boom'); error.response={status:500}; throw error; }
        if(rejectBody) { const error=new Error('bad'); error.response={status:400,data:{message:rejectBody}}; throw error; }
        submissions++; env=Object.fromEntries(spec.parameterSet.envVariables.map(e=>[e.key,e.value]));
        assert(!Object.values(env).includes(token()));
        job={uuid:'accepted-tapis-job',name:spec.name,appId:spec.appId,appVersion:spec.appVersion,owner:'operator'};
        return {data:{result:{uuid:job.uuid}}};
    },put:async()=>{stops++;return {data:{}};}});
    let workerStart;
    const requestWorker=async (_url,route,_credential,method,body)=> {
        if(route==='/info') return {engine:'nodesplat',capabilities:['opensplat-webodm-v1']};
        if(route==='/task/new') { newCalls++; workerStart=body; return {uuid:body['set-uuid']}; }
        if(route==='/task/remove') { removeCalls++; if(removeFails) throw new Error('worker unavailable'); return {success:true}; }
        if(/^\/task\/[^/]+\/info$/.test(route)) { if(!workerInfo) throw new Error('worker unavailable'); return workerInfo; }
        return {success:true};
    };
    const deps={api,workerRequest:requestWorker};
    const reg=async(service,id,patch={})=> {
        try { return {status:200,body:await service.registerWorker(Object.assign({hostname:HOST,port:4444,nodeToken:env.NODESPLAT_API_CAPABILITY,registrationUuid:id,tapisJobUuid:job.uuid,role:'nodesplat'},patch))}; }
        catch(error) { return {status:error.status,body:{error:error.message}}; }
    };
    const newRun=()=> {
        const runId=uuid();
        fs.mkdirSync(path.join(inputRoot,runId,'input'),{recursive:true});
        fs.writeFileSync(path.join(inputRoot,runId,'input/webodm-input.json'),'{}');
        const body={run_id:runId,source_task_id:uuid(),manifest_sha256:hash('{}'),profile_id:'nodesplat-v1',settings:{num_iterations:100,image_size:1920}};
        body.grant=grant(body);
        return body;
    };
    const publish=(runId,id,body)=> {
        fs.mkdirSync(path.join(outputRoot,runId),{recursive:true});
        fs.writeFileSync(path.join(outputRoot,runId,'model.ply'),'test-model');
        fs.writeFileSync(path.join(outputRoot,runId,'manifest.json'),JSON.stringify({run_id:runId,source_task_id:body.source_task_id,cluster_task_uuid:id,tapis_job_uuid:job.uuid,profile_id:'nodesplat-v1',app:{id:profile.appId,version:profile.appVersion},settings:body.settings,output:{bytes:10,sha256:hash('test-model')}}));
    };
    let service=new SplatTasks(config,deps);
    try {
        assert.throws(()=>new SplatTaskStore(config.storeDir),/locked/);
        const body=newRun(),runId=body.run_id;
        const denied=await call(service,'POST','/splat/task/new',Object.assign({},body,{grant:grant(body,'someone-else')}));
        assert.strictEqual(denied.status,403);
        const created=await call(service,'POST','/splat/task/new',body);
        assert.strictEqual(created.status,202);assert.strictEqual(created.body.state,'queued');
        const id=created.body.uuid;
        assert.strictEqual(submissions,1);
        // Worker credential is the per-job API token only: no cluster-wide secret and no callback capability reach the job.
        assert.strictEqual(env.NODESPLAT_REGISTRATION_SECRET,undefined);assert(!Object.values(env).includes(REG_SECRET));
        assert.strictEqual(env.NODESPLAT_CALLBACK_URL,'https://cluster.invalid');
        assert(!('NODESPLAT_CALLBACK_CAPABILITY' in env));
        const persisted=fs.readFileSync(path.join(config.storeDir,id+'.json'),'utf8');
        assert(!persisted.includes(env.NODESPLAT_API_CAPABILITY));assert(!persisted.includes(REG_SECRET));assert(!persisted.includes(token()));assert(!persisted.includes('callback_hash'));
        assert.strictEqual((await call(service,'POST','/splat/task/new',Object.assign({},body,{grant:grant(body,'operator',true)}))).status,200);
        assert.strictEqual(submissions,1);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/info`,undefined,token('other'))).status,403);
        // Lookup by WebODM run id: recovers the task id for a run whose submission outcome is unknown
        const found=await call(service,'GET',`/splat/run/${body.run_id}`);
        assert.strictEqual(found.status,200);assert.strictEqual(found.body.uuid,id);assert.strictEqual(found.body.run_id,body.run_id);
        assert.strictEqual((await call(service,'GET',`/splat/run/${uuid()}`)).status,404);
        assert.strictEqual((await call(service,'GET','/splat/run/not-a-uuid')).status,404);
        assert.strictEqual((await call(service,'GET',`/splat/run/${body.run_id}`,undefined,token('other'))).status,403);
        assert.strictEqual((await call(service,'GET',`/splat/run/${body.run_id}`,undefined,'')).status,401);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/output?line=-1`)).status,400);
        // The old unauthenticated worker routes no longer exist.
        for(const route of ['/splat/worker/register','/splat/worker/heartbeat']) assert.strictEqual((await call(service,'POST',route,{uuid:id})).status,404);

        // Webhook registration rejections
        // The cluster-wide NodeODX secret does not authenticate a splat worker; only the per-job token does
        assert.strictEqual((await reg(service,id,{nodeToken:undefined,registrationSecret:REG_SECRET})).status,403);
        assert.strictEqual((await reg(service,id,{tapisJobUuid:'another-job'})).status,403);
        assert.strictEqual((await reg(service,id,{tapisJobUuid:undefined})).status,403);
        assert.strictEqual((await reg(service,id,{nodeToken:'x'.repeat(43)})).status,403);
        assert.strictEqual((await reg(service,id,{nodeToken:''})).status,403);
        assert.strictEqual((await reg(service,uuid())).status,403);
        assert.strictEqual((await reg(service,'not-a-uuid')).status,403);
        assert.strictEqual((await reg(service,id,{hostname:'bad host/x'})).status,400);
        assert.strictEqual((await reg(service,id,{port:0})).status,400);
        assert.strictEqual((await reg(service,id,{port:'4444'})).status,400);
        assert.strictEqual(newCalls,0);
        // Valid registration, then idempotent keepalive and conflicting identity
        let result=await reg(service,id);
        assert.strictEqual(result.status,200);assert.deepStrictEqual(result.body,{success:true,uuid:id});
        assert.strictEqual(workerStart['set-uuid'],id);assert.strictEqual(workerStart.run_id,runId);assert.strictEqual(newCalls,1);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/info`)).body.state,'running');
        assert.strictEqual((await reg(service,id)).status,200);
        assert.strictEqual(newCalls,1,'keepalive must not restart the task');
        assert.strictEqual((await reg(service,id,{port:5555})).status,409);
        assert.strictEqual((await reg(service,id,{hostname:'c999-999.ls6.tacc.utexas.edu'})).status,409);
        assert(!require('../libs/nodes').all().some(node=>node && node.engine==='nodesplat'));

        fs.mkdirSync(path.join(outputRoot,runId));
        fs.writeFileSync(path.join(outputRoot,runId,'console.txt'),'preparing\niteration 1\n');
        let output=await call(service,'GET',`/splat/task/${id}/output?line=1`);
        assert.deepStrictEqual(output.body.lines,['iteration 1']);assert.strictEqual(output.body.next_line,2);

        // Polling on sync updates phase/progress; invalid progress is ignored
        workerInfo={status:{code:20},phase:'training',progress:{iteration:50,total:100}};
        let info=(await call(service,'POST',`/splat/task/${id}/sync`,{})).body;
        assert.strictEqual(info.state,'running');assert.strictEqual(info.phase,'training');assert.strictEqual(info.worker_status,20);
        assert.deepStrictEqual(info.progress,{iteration:50,total:100});
        workerInfo={status:{code:20},phase:'training\nforged',progress:{iteration:5,total:7}};
        info=(await call(service,'POST',`/splat/task/${id}/sync`,{})).body;
        assert.deepStrictEqual(info.progress,{iteration:50,total:100});assert(!/\n/.test(info.phase));

        // result_ready is verified, then acknowledged with /task/remove (retried until it succeeds)
        workerInfo={status:{code:40},phase:'result_ready',result_ready:true};
        info=(await call(service,'POST',`/splat/task/${id}/sync`,{})).body;
        assert.strictEqual(info.phase,'Training artifacts failed verification');assert.strictEqual(info.state,'running');
        assert.strictEqual(removeCalls,0,'unverifiable artifacts are never acknowledged');
        publish(runId,id,body);
        removeFails=true;
        info=(await call(service,'POST',`/splat/task/${id}/sync`,{})).body;
        assert.strictEqual(info.state,'result_ready');assert.strictEqual(removeCalls,1);
        removeFails=false;
        assert.strictEqual((await call(service,'POST',`/splat/task/${id}/sync`,{})).body.state,'result_ready');
        assert.strictEqual(removeCalls,2);
        await call(service,'POST',`/splat/task/${id}/sync`,{});
        assert.strictEqual(removeCalls,2,'acknowledged once');

        // Restart: the in-memory worker token is lost; a keepalive registration restores it without restarting the task
        service.close();service=new SplatTasks(config,deps);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/info`)).body.state,'result_ready');
        workerInfo={status:{code:20},phase:'after-restart'};
        // No worker session yet: polling is skipped, so the last worker status (completed) is unchanged
        let restarted=(await call(service,'POST',`/splat/task/${id}/sync`,{})).body;
        assert.strictEqual(restarted.worker_status,40);assert.strictEqual(restarted.phase,'Training complete; releasing GPU worker');
        assert.strictEqual((await reg(service,id)).status,200);
        assert.strictEqual(newCalls,1);
        // Keepalive restored the session, so polling resumes; cluster phase text is kept once result_ready
        restarted=(await call(service,'POST',`/splat/task/${id}/sync`,{})).body;
        assert.strictEqual(restarted.worker_status,20);assert.strictEqual(restarted.state,'result_ready');
        jobStatus='FINISHED';
        assert.strictEqual((await call(service,'POST',`/splat/task/${id}/sync`,{})).body.state,'ready');
        output=await call(service,'GET',`/splat/task/${id}/output?line=0`);assert.strictEqual(output.body.eof,true);
        assert.strictEqual(submissions,1);
        // Terminal record: registration is refused (credentials revoked)
        assert.strictEqual((await reg(service,id)).status,403);
        assert.strictEqual((await call(service,'POST','/splat/task/new',Object.assign({},body,{input_path:'/etc/passwd'}))).status,400);

        // Worker-reported failure is acknowledged and the allocation result decides the final state
        jobStatus='RUNNING';removeCalls=0;newCalls=0;workerInfo=null;
        const second=newRun();
        const created2=await call(service,'POST','/splat/task/new',second);
        assert.strictEqual(created2.status,202);const id2=created2.body.uuid;
        assert.strictEqual((await reg(service,id2)).status,200);
        workerInfo={status:{code:30},phase:'failed',error:'boom'};
        let failed=(await call(service,'POST',`/splat/task/${id2}/sync`,{})).body;
        assert.strictEqual(failed.worker_status,30);assert.strictEqual(removeCalls,1);
        jobStatus='FINISHED';
        failed=(await call(service,'POST',`/splat/task/${id2}/sync`,{})).body;
        assert.strictEqual(failed.state,'failed');assert.strictEqual(failed.error.code,'training_failed');
        assert.strictEqual(stops,0);
    } finally {service.close();}

    // Registration before the Tapis job UUID is recorded must be retried (409), never accepted
    const unknownDir=path.join(root,'store-unknown');
    let unknown=new SplatTasks(Object.assign({},config,{storeDir:unknownDir}),deps);
    try {
        failSubmit=true;
        const body=newRun();
        const created=await call(unknown,'POST','/splat/task/new',body);
        assert.strictEqual(created.status,202);assert.strictEqual(created.body.state,'submission_unknown');
        const stored=JSON.parse(fs.readFileSync(path.join(unknownDir,created.body.uuid+'.json'),'utf8'));
        const result=await reg(unknown,created.body.uuid,{tapisJobUuid:'accepted-tapis-job',nodeToken:'x'});
        assert.strictEqual(result.status,409);assert.strictEqual(stored.tapis_job_uuid,null);
    } finally {failSubmit=false;unknown.close();}

    // A Tapis rejection explains itself: its message reaches the task, with tokens removed and length bounded
    const rejectedDir=path.join(root,'store-rejected');
    const rejected=new SplatTasks(Object.assign({},config,{storeDir:rejectedDir}),deps);
    try {
        rejectBody='JOBS_ARCHIVE_DIR_INVALID: cannot evaluate HOST_EVAL($SCRATCH) on system cloud.data eyJabc.def.ghi '+'x'.repeat(500);
        const refused=await call(rejected,'POST','/splat/task/new',newRun());
        assert.strictEqual(refused.status,202);assert.strictEqual(refused.body.state,'failed');
        const detail=refused.body.error.message;
        assert(/HTTP 400/.test(detail)&&/JOBS_ARCHIVE_DIR_INVALID/.test(detail)&&/HOST_EVAL/.test(detail),detail);
        assert(!/eyJabc/.test(detail)&&detail.length<=400,'token removed and bounded');
        // No explanation from Tapis: still a clear generic message
        rejectBody=null;failSubmit=false;
    } finally {rejectBody=null;rejected.close();}

    // Worker URL shape only (same trust model as NodeODX); no allowlist
    assert.strictEqual(parseWorkerUrl('http://c301-001.ls6.tacc.utexas.edu:3101/').port,'3101');
    for(const bad of ['ftp://x:1/','http://u:p@x:1/','http://x:1/path','http://x:1/?q=1','not a url'])
        assert.throws(()=>parseWorkerUrl(bad),bad);
    const disabled=new SplatTasks();assert.strictEqual((await call(disabled,'POST','/splat/task/new',{})).status,503);
    console.log('NodeSplat authorization, durable lifecycle, restart, artifact and console tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
