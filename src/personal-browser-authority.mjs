import { companyForChat } from '../public/company-scope.js';
import { environmentCompany } from '../public/environment-scope.js';
import { createHash } from 'node:crypto';

// Reads durable records on every boundary; no credential value is returned.
export async function personalBrowserScope({store,records,resources,agentAccounts},chatId) {
  const chat = store.get(chatId);
  if (!chat?.ownerId || chat.archived || !chat.environmentId || !chat.agentAccountId || !['codex','claude'].includes(chat.agent)) throw Error('A current named agent account and company environment are required');
  const identity = value => JSON.stringify([value?.ownerId,value?.agent,value?.agentAccountId,value?.environmentId,companyForChat(value || {}),Boolean(value?.archived ?? value?.workflowState === 'archived')]);
  const initial = identity(chat), durable = await records.get('chat',chatId);
  if (!durable || identity(durable) !== initial) throw Error('Browser scope is not durably current');
  const services = await resources.forOwner(chat.ownerId);
  const read = async () => {
    const account = await agentAccounts.select(chat.ownerId,chat.agentAccountId,chat);
    if (await records.get('agent-account-disconnection',account.id)) throw Error('Agent account access revoked');
    const company = await services.companies.get(companyForChat(chat));
    const environment = await services.environments.get(chat.environmentId);
    if (environment.archived || environment.scopeNeedsReview || environmentCompany(environment) !== company.id) throw Error('Environment company access revoked');
    return {ownerId:chat.ownerId,chatId,companyId:company.id,environmentId:environment.id,provider:chat.agent,accountId:account.id,accountRevision:account.revision,companyRevision:company.revision,environmentRevision:environment.revision,
      accountIdentityHash:createHash('sha256').update(JSON.stringify([account.accountIdentity || null,account.subject || null])).digest('hex')};
  };
  const scope = await read(), checked = await read();
  const finalDurable = await records.get('chat',chatId);
  if (JSON.stringify(scope) !== JSON.stringify(checked) || !finalDurable || identity(finalDurable) !== initial || identity(store.get(chatId)) !== initial) throw Error('Browser scope changed');
  const account = {id:scope.accountId};
  agentAccounts.assertConnected(chat.ownerId,account.id,chat.agent);
  return scope;
}
