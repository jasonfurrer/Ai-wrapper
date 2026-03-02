/**
 * API types matching backend schemas (app/schemas/).
 * API uses snake_case in JSON.
 */

// -----------------------------------------------------------------------------
// Activity list query params (GET /api/v1/activities)
// -----------------------------------------------------------------------------

export type ActivitySortOption =
  | 'due_date_newest'
  | 'due_date_oldest'
  | 'last_touch_newest'
  | 'last_touch_oldest'
  | 'priority_high_low'
  | 'priority_low_high';

export interface ActivityQueryParams {
  date?: string; // YYYY-MM-DD
  relationship_status?: string[];
  processing_status?: string[];
  date_from?: string; // YYYY-MM-DD
  date_to?: string; // YYYY-MM-DD
  sort?: ActivitySortOption;
  /** Search by keyword (subject, contact, company); backend fetches from HubSpot; returns completed and not completed */
  search?: string;
}

// -----------------------------------------------------------------------------
// Contact / Company info (embedded in activity response)
// -----------------------------------------------------------------------------

export interface ContactInfo {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  hubspot_id?: string | null;
  phone?: string | null;
  mobile_phone?: string | null;
  company_name?: string | null;
}

export interface CompanyInfo {
  id: string;
  name?: string | null;
  domain?: string | null;
  hubspot_id?: string | null;
}

// -----------------------------------------------------------------------------
// Activity (single activity with optional contact/company details)
// -----------------------------------------------------------------------------

export interface DashboardActivity {
  id: string;
  type?: string | null;
  subject?: string | null;
  body?: string | null;
  due_date?: string | null;
  completed?: boolean;
  contact_ids?: string[];
  company_ids?: string[];
  created_at?: string | null;
  updated_at?: string | null;
  hubspot_id?: string | null;
  /** Priority from HubSpot hs_task_priority: 'none' | 'low' | 'medium' | 'high' */
  priority?: string | null;
  contacts?: ContactInfo[];
  companies?: CompanyInfo[];
}

// -----------------------------------------------------------------------------
// List response
// -----------------------------------------------------------------------------

export interface ActivityListResponse {
  activities: DashboardActivity[];
}

// -----------------------------------------------------------------------------
// Create / Update payloads
// -----------------------------------------------------------------------------

export interface CreateActivityData {
  type?: string | null;
  subject?: string | null;
  body?: string | null;
  due_date?: string | null;
  completed?: boolean;
  contact_ids?: string[];
  company_ids?: string[];
  hubspot_id?: string | null;
}

export interface UpdateActivityData {
  type?: string | null;
  subject?: string | null;
  body?: string | null;
  due_date?: string | null;
  completed?: boolean | null;
  contact_ids?: string[] | null;
  company_ids?: string[] | null;
}

// -----------------------------------------------------------------------------
// Sync response
// -----------------------------------------------------------------------------

export interface SyncResponse {
  synced: boolean;
  message: string;
  tasks_count?: number;
}

// -----------------------------------------------------------------------------
// Dashboard state (GET/PUT /api/v1/dashboard/state)
// -----------------------------------------------------------------------------

export interface DashboardState {
  selected_activity_id?: string | null;
  sort_option: string;
  filter_state: Record<string, unknown>;
  date_picker_value?: string | null;
  updated_at?: string | null;
}

// -----------------------------------------------------------------------------
// Contact (GET/POST/PUT /api/v1/contacts)
// -----------------------------------------------------------------------------

export interface Contact {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  hubspot_id?: string | null;
  phone?: string | null;
  mobile_phone?: string | null;
  job_title?: string | null;
  relationship_status?: string | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ContactListResponse {
  contacts: Contact[];
}

export interface ContactCreate {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  job_title?: string | null;
  company_id?: string | null;
  relationship_status?: string | null;
  notes?: string | null;
}

export interface ContactUpdate {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  company_id?: string | null;
  relationship_status?: string | null;
  notes?: string | null;
}

// -----------------------------------------------------------------------------
// Activity page: process notes & submit (POST /api/v1/activities/{id}/...)
// -----------------------------------------------------------------------------

export interface ProcessNotesRequest {
  note_text: string;
}

export interface ProcessDraftRequest {
  note_text: string;
  previous_notes?: string;
}

export interface RecognisedDateOut {
  date: string | null;
  label: string | null;
  confidence: number;
}

export interface RecommendedTouchDateOut {
  date: string;
  label: string;
  rationale: string;
}

export interface ExtractedMetadataOut {
  subject: string;
  questions_raised: string;
  urgency: 'low' | 'medium' | 'high';
  subject_confidence: number;
  questions_confidence: number;
}

export interface DraftOut {
  text: string;
  confidence: number;
}

export interface ProcessNotesResponse {
  summary: string;
  recognised_date: RecognisedDateOut;
  recommended_touch_date: RecommendedTouchDateOut | null;
  metadata: ExtractedMetadataOut;
  drafts: Record<string, DraftOut>;
}

export interface ActivitySubmitRequest {
  mark_complete?: boolean;
  meeting_notes?: string | null;
  activity_date?: string | null; // YYYY-MM-DD; date task was performed (used for note prefix)
  due_date?: string | null;
  subject?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  /** Priority: 'none' | 'low' | 'medium' | 'high'. Maps to HubSpot hs_task_priority (LOW/MEDIUM/HIGH); 'none' omits. */
  priority?: string | null;
}

export interface RegenerateDraftRequest {
  tone: string;
  current_note: string;
  previous_notes: string;
}

// -----------------------------------------------------------------------------
// Generate email drafts (Smart compose) POST /api/v1/activities/generate-email-drafts
// -----------------------------------------------------------------------------

export interface GenerateEmailDraftsRequest {
  email_instructions: string;
  client_notes: string;
  task_title: string;
  last_touch_date?: string | null;
  sender_name?: string | null;
}

export interface GenerateEmailDraftsResponse {
  drafts: Record<string, DraftOut>; // keys: warm, concise, formal
  suggested_subject?: string;
}

// -----------------------------------------------------------------------------
// Communication summary (GET /api/v1/activities/{id}/communication-summary)
// -----------------------------------------------------------------------------

export interface CommunicationSummaryResponse {
  summary: string;
  times_contacted: string;
  relationship_status: string;
}
