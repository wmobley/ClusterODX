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
const {inCidr,targetFor}=require('../libs/splatNetwork');
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
(async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluster-splat-'));
    const inputRoot=path.join(root,'input'),outputRoot=path.join(root,'output');
    fs.mkdirSync(inputRoot);fs.mkdirSync(outputRoot);
    const profile={baseUrl:'https://example.tapis.invalid',tenantId:'portals',appId:'nodesplat-ls6',appVersion:'0.1.0',executionSystemId:'ls6',archiveSystemId:'cloud.data',queue:'gpu-test',allocation:'TEST',coresPerNode:1,memoryMB:4096,maxMinutes:10,inputRoot,outputRoot,callbackUrl:'https://cluster.invalid/splat/worker',workerBindHost:'0.0.0.0',workerPort:4444};
    const config={enabled:true,instanceId:'test-cluster',storeDir:path.join(root,'store'),grantKeys:{webodm:{test:secret}},profile};
    let submissions=0,stops=0,jobStatus='RUNNING',job,env,workerStart;
    const api=()=>({get:async url=> {
        if(url==='/v3/systems') return {data:{result:[]}};
        if(url==='/v3/jobs/search') return {data:{result:job?[job]:[]}};
        return {data:{result:Object.assign({},job,{status:jobStatus})}};
    },post:async (_url,spec)=> {
        submissions++; env=Object.fromEntries(spec.parameterSet.envVariables.map(e=>[e.key,e.value]));
        assert(!Object.values(env).includes(token()));
        job={uuid:'accepted-tapis-job',name:spec.name,appId:spec.appId,appVersion:spec.appVersion,owner:'operator'};
        return {data:{result:{uuid:job.uuid}}};
    },put:async()=>{stops++;return {data:{}};}});
    const requestWorker=async (_url,route,_credential,_policy,method,body)=> {
        if(route==='/info') return {engine:'nodesplat',capabilities:['opensplat-webodm-v1']};
        if(route==='/task/new') { workerStart=body; return {uuid:body['set-uuid']}; }
        return {ok:true};
    };
    let service=new SplatTasks(config,{api,workerRequest:requestWorker});
    try {
        assert.throws(()=>new SplatTaskStore(config.storeDir),/locked/);
        const runId=uuid();
        fs.mkdirSync(path.join(inputRoot,runId,'input'),{recursive:true});
        fs.writeFileSync(path.join(inputRoot,runId,'input/webodm-input.json'),'{}');
        const body={run_id:runId,source_task_id:uuid(),manifest_sha256:hash('{}'),profile_id:'nodesplat-v1',settings:{num_iterations:100,image_size:1920}};
        body.grant=grant(body);
        const denied=await call(service,'POST','/splat/task/new',Object.assign({},body,{grant:grant(body,'someone-else')}));
        assert.strictEqual(denied.status,403);
        const created=await call(service,'POST','/splat/task/new',body);
        assert.strictEqual(created.status,202);assert.strictEqual(created.body.state,'queued');
        const id=created.body.uuid;
        assert.strictEqual(submissions,1);
        const persisted=fs.readFileSync(path.join(config.storeDir,id+'.json'),'utf8');
        assert(!persisted.includes(env.NODESPLAT_API_CAPABILITY));assert(!persisted.includes(env.NODESPLAT_CALLBACK_CAPABILITY));assert(!persisted.includes(token()));
        assert.strictEqual((await call(service,'POST','/splat/task/new',Object.assign({},body,{grant:grant(body,'operator',true)}))).status,200);
        assert.strictEqual(submissions,1);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/info`,undefined,token('other'))).status,403);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/output?line=-1`)).status,400);
        const worker={uuid:id,run_id:runId,tapis_job_uuid:job.uuid,profile_id:'nodesplat-v1',url:'https://worker.invalid:4444',api_capability:env.NODESPLAT_API_CAPABILITY};
        assert.strictEqual((await call(service,'POST','/splat/worker/register',worker,'wrong')).status,403);
        assert.strictEqual((await call(service,'POST','/splat/worker/register',worker,env.NODESPLAT_CALLBACK_CAPABILITY)).status,200);
        assert.strictEqual(workerStart['set-uuid'],id);
        assert(!require('../libs/nodes').all().some(node=>node && node.engine==='nodesplat'));
        fs.mkdirSync(path.join(outputRoot,runId));
        fs.writeFileSync(path.join(outputRoot,runId,'console.txt'),'preparing\niteration 1\n');
        let output=await call(service,'GET',`/splat/task/${id}/output?line=1`);
        assert.deepStrictEqual(output.body.lines,['iteration 1']);assert.strictEqual(output.body.next_line,2);
        fs.writeFileSync(path.join(outputRoot,runId,'model.ply'),'test-model');
        const manifest={run_id:runId,source_task_id:body.source_task_id,cluster_task_uuid:id,tapis_job_uuid:job.uuid,profile_id:'nodesplat-v1',app:{id:profile.appId,version:profile.appVersion},settings:body.settings,output:{bytes:10,sha256:hash('test-model')}};
        fs.writeFileSync(path.join(outputRoot,runId,'manifest.json'),JSON.stringify(manifest));
        const callback=Object.assign({},worker,{state:'result_ready',phase:'Training complete',progress:{iteration:100,total:100}});
        const ready=await call(service,'POST','/splat/worker/heartbeat',callback,env.NODESPLAT_CALLBACK_CAPABILITY);
        assert.strictEqual(ready.body.acknowledged,true);
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/info`)).body.state,'result_ready');
        service.close();service=new SplatTasks(config,{api,workerRequest:requestWorker});
        assert.strictEqual((await call(service,'GET',`/splat/task/${id}/info`)).body.state,'result_ready');
        assert.strictEqual((await call(service,'POST','/splat/worker/register',worker,env.NODESPLAT_CALLBACK_CAPABILITY)).status,200);
        jobStatus='FINISHED';
        assert.strictEqual((await call(service,'POST',`/splat/task/${id}/sync`,{})).body.state,'ready');
        output=await call(service,'GET',`/splat/task/${id}/output?line=0`);assert.strictEqual(output.body.eof,true);
        assert.strictEqual(submissions,1);
        assert.strictEqual((await call(service,'POST','/splat/worker/heartbeat',callback,env.NODESPLAT_CALLBACK_CAPABILITY)).status,403);
        // New grant cannot create an arbitrary path or reuse another user's snapshot.
        assert.strictEqual((await call(service,'POST','/splat/task/new',Object.assign({},body,{input_path:'/etc/passwd'}))).status,400);
        assert.strictEqual(stops,0);
    } finally {service.close();}
    assert(inCidr('10.2.3.4','10.0.0.0/8'));assert(!inCidr('169.254.169.254','10.0.0.0/8'));
    const {hostAllowed}=require('../libs/splatNetwork');
    assert(hostAllowed('c301-001.ls6.tacc.utexas.edu',['*.ls6.tacc.utexas.edu']));
    assert(hostAllowed('Worker.Invalid',['worker.invalid']));
    for(const bad of ['ls6.tacc.utexas.edu','a.b.ls6.tacc.utexas.edu','evil-ls6.tacc.utexas.edu','c1.ls6.tacc.utexas.edu.evil.com','.ls6.tacc.utexas.edu'])
        assert(!hostAllowed(bad,['*.ls6.tacc.utexas.edu']),bad);
    assert(!hostAllowed('anything.example',['*.']) && !hostAllowed('anything.example',['*']) && !hostAllowed('a.example',['*.*.example']));
    await assert.rejects(()=>targetFor('http://169.254.169.254/',{schemes:['http'],hosts:['worker.invalid'],ports:[80],cidrs:['10.0.0.0/8']}));
    const disabled=new SplatTasks();assert.strictEqual((await call(disabled,'POST','/splat/task/new',{})).status,503);
    console.log('NodeSplat authorization, durable lifecycle, restart, artifact and console tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
