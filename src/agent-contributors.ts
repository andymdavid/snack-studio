/** Contributor access follows the same read/edit roles as the Studio UI. */
export function agentContributorRoute(method: string, path: string): boolean {
  return (method === 'GET' && /^\/api\/contributors(?:\/[^/]+(?:\/reference-photo)?)?$/.test(path))
    || (method === 'POST' && path === '/api/contributors')
    || (method === 'PATCH' && /^\/api\/contributors\/[^/]+$/.test(path));
}

/** JSON transport for signed clients; browsers retain their multipart transport. */
export async function contributorForm(req: Request): Promise<FormData> {
  if (!req.headers.get('content-type')?.includes('application/json')) return req.formData();
  const body = await req.json() as Record<string, unknown>;
  const form = new FormData();
  for (const field of ['id','name','role','shortBio','biographyMarkdown','speakerAlias','externalUrl','xUrl','linkedinUrl','nostrUrl']) {
    if (typeof body[field] === 'string') form.set(field, body[field] as string);
  }
  if (Array.isArray(body.aliases) && body.aliases.every(x => typeof x === 'string')) form.set('aliases', body.aliases.join(','));
  else if (typeof body.aliases === 'string') form.set('aliases', body.aliases);
  if (body.photoBase64 !== undefined) {
    if (typeof body.photoBase64 !== 'string' || body.photoBase64.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.photoBase64)) throw Error('Invalid reference photo encoding');
    if (!['image/png','image/jpeg','image/webp'].includes(String(body.photoContentType))) throw Error('Reference photo must be JPEG, PNG or WebP');
    const bytes = Buffer.from(body.photoBase64, 'base64');
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw Error('Reference photo must be 12 MB or smaller');
    form.set('photo', new File([bytes], 'reference-photo', {type:String(body.photoContentType)}));
  }
  return form;
}
