/**
 * Gmail API for contact page: search emails, get message, extract contact.
 */

import { getAuthHeaders } from './activities';
import { ApiClientError, buildApiUrl } from './client';

export type GmailMessageFolder = 'inbox' | 'sent' | 'both';

export interface GmailSearchMessage {
  id: string;
  subject: string;
  from: string;
  to: string;
  snippet: string;
  date: string;
  /** ISO date from backend (internalDate) for reliable formatting */
  date_iso?: string;
  /** Set by backend when folder=all so frontend can filter without refetching */
  folder?: GmailMessageFolder;
}

export interface GmailSearchResponse {
  messages: GmailSearchMessage[];
}

export interface GmailMessageResponse {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface ExtractedContact {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_title: string;
  company_name: string;
  company_domain: string;
  city: string;
  state_region: string;
  company_owner: string;
}

export type GmailSearchFolder = 'all' | 'inbox' | 'sent';

export async function gmailSearchEmails(
  query: string,
  folder: GmailSearchFolder = 'all',
  filterDate?: string | null,
): Promise<GmailSearchMessage[]> {
  const params: Record<string, string> = { q: query, folder };
  if (filterDate && filterDate.trim()) params.date = filterDate.trim();
  const url = buildApiUrl('/api/v1/gmail/search', params);
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiClientError(res.statusText, res.status, text || undefined);
  }
  const data = (await res.json()) as GmailSearchResponse;
  return data.messages ?? [];
}

export async function gmailGetMessage(messageId: string): Promise<GmailMessageResponse> {
  const url = buildApiUrl(`/api/v1/gmail/messages/${encodeURIComponent(messageId)}`);
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiClientError(res.statusText, res.status, text || undefined);
  }
  return res.json() as Promise<GmailMessageResponse>;
}

export async function gmailExtractContact(messageId: string): Promise<ExtractedContact> {
  const url = buildApiUrl('/api/v1/gmail/extract-contact');
  const headers = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiClientError(res.statusText, res.status, text || undefined);
  }
  return res.json() as Promise<ExtractedContact>;
}

export interface GenerateActivityNoteResponse {
  note: string;
}

export async function gmailGenerateActivityNote(messageId: string): Promise<GenerateActivityNoteResponse> {
  const url = buildApiUrl('/api/v1/gmail/generate-activity-note');
  const headers = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiClientError(res.statusText, res.status, text || undefined);
  }
  return res.json() as Promise<GenerateActivityNoteResponse>;
}

export interface GmailSendAttachment {
  filename: string;
  content_base64: string;
  content_type: string;
}

export interface GmailSendRequest {
  to: string;
  subject: string;
  body: string;
  attachments?: GmailSendAttachment[];
}

export interface GmailSendResponse {
  id: string;
  message: string;
}

export async function gmailSendEmail(data: GmailSendRequest): Promise<GmailSendResponse> {
  const headers = await getAuthHeaders();
  const payload: Record<string, unknown> = {
    to: data.to.trim(),
    subject: data.subject.trim(),
    body: data.body,
  };
  if (data.attachments?.length) {
    payload.attachments = data.attachments;
  }
  const res = await fetch(buildApiUrl('/api/v1/gmail/send'), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail: string | Record<string, unknown> = text || res.statusText;
    try {
      const json = JSON.parse(text) as { detail?: string };
      if (json.detail) detail = json.detail;
    } catch {
      // use text
    }
    throw new ApiClientError(res.statusText, res.status, detail);
  }
  return res.json() as Promise<GmailSendResponse>;
}
