import {expect,test} from 'bun:test';
import {agentContributorRoute,contributorForm} from './agent-contributors.ts';
import {agentProductionRoute} from './agent-production-policy.ts';
import {validateContributorProfile} from './contributor-input.ts';
test('signed contributor CRUD uses exact routes and excludes deletion and unrelated writes',()=>{
 for(const [m,p] of [['GET','/api/contributors'],['GET','/api/contributors/mitch'],['GET','/api/contributors/mitch/reference-photo'],['POST','/api/contributors'],['PATCH','/api/contributors/mitch']]) expect(agentProductionRoute(m!,p!)).toBe(true);
 for(const [m,p] of [['DELETE','/api/contributors/mitch'],['POST','/api/contributors/mitch/approve'],['POST','/api/access'],['POST','/api/episodes/ep/approve'],['POST','/api/episodes/ep/git-publication'],['POST','/api/episodes/ep/git-deployment']]) expect(agentProductionRoute(m!,p!)).toBe(false);
 expect(agentContributorRoute('POST','/api/episodes/ep/pipeline-requests')).toBe(false);
});
test('signed JSON retains speaker alias and supplied photo for existing contributor validation',async()=>{
 const form=await contributorForm(new Request('http://studio/api/contributors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'mitch-catterall',name:'Dr. Mitch Catterall',aliases:['Dr Mitch - Unveil'],photoBase64:'aGVsbG8=',photoContentType:'image/png'})}));
 expect(validateContributorProfile(form).aliases).toContain('Dr Mitch - Unveil');
 expect(await (form.get('photo') as File).text()).toBe('hello');
});
test('bad image transport fails before contributor creation',async()=>{
 for(const photo of [{photoBase64:'???',photoContentType:'image/png'},{photoBase64:'aA==',photoContentType:'text/html'}]) await expect(contributorForm(new Request('http://studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(photo)}))).rejects.toThrow();
});
test('browser multipart input remains supported',async()=>{
 const f=new FormData();f.set('name','Mitch');
 expect((await contributorForm(new Request('http://studio',{method:'POST',body:f}))).get('name')).toBe('Mitch');
});
