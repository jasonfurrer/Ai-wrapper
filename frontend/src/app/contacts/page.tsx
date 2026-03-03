'use client';

import * as React from 'react';
import { Suspense } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2, X, Users, Search, Pencil, Trash2, Info, CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusChip, type RelationshipStatus } from '@/components/shared/status-chip';
import { EmptyState } from '@/components/shared/empty-state';
import {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
} from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContact,
  getContact,
  updateContact,
  deleteContact,
  searchContacts,
  searchCompanies,
  createCompany,
  type Contact as ApiContact,
  type CompanySearchResult,
  type CompanyDetailResponse,
} from '@/lib/api';
import {
  gmailSearchEmails,
  gmailExtractContact,
  type GmailSearchMessage,
  type ExtractedContact,
  type GmailSearchFolder,
} from '@/lib/api/gmail';
import { getGmailStatus } from '@/lib/api/integrations';

/** Filter messages by All / Inbox / Sent using each message's folder tag (from backend). */
function filterMessagesByFolder(
  messages: GmailSearchMessage[],
  folder: GmailSearchFolder,
): GmailSearchMessage[] {
  if (folder === 'all') return messages;
  if (folder === 'inbox') return messages.filter((m) => m.folder === 'inbox' || m.folder === 'both');
  return messages.filter((m) => m.folder === 'sent' || m.folder === 'both');
}

/** Format email date for display (e.g. "17 Feb 2025, 10:30" or "Today, 10:30"). */
function formatEmailDate(msg: GmailSearchMessage): string {
  const raw = msg.date_iso || msg.date;
  if (!raw || !raw.trim()) return '—';
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return msg.date?.trim() || '—';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (dDate.getTime() === today.getTime()) return `Today, ${time}`;
    if (dDate.getTime() === yesterday.getTime()) return `Yesterday, ${time}`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + time;
  } catch {
    return msg.date?.trim() || '—';
  }
}
import { cn } from '@/lib/utils';
import { Mail } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

const RELATIONSHIP_OPTIONS: RelationshipStatus[] = [
  'Active',
  'Warm',
  'Cooling',
  'Dormant',
  'At-Risk',
];

const MOCK_CONTACTS = [
  { id: 'c1', name: 'Jane Cooper' },
  { id: 'c2', name: 'Robert Fox' },
];

export interface AddContactFormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  accountId: string;
  accountSearchDisplay: string;
  relationshipStatus: string;
}

const INITIAL_ADD_CONTACT_FORM: AddContactFormState = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  jobTitle: '',
  accountId: '',
  accountSearchDisplay: '',
  relationshipStatus: '',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[\d\s\-+.()]*$/;

const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Hooks & helpers
// ---------------------------------------------------------------------------

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

function validatePhone(phone: string): boolean {
  if (!phone.trim()) return true;
  return PHONE_REGEX.test(phone) && phone.replace(/\D/g, '').length >= 10;
}

// ---------------------------------------------------------------------------
// Debounced autocomplete
// ---------------------------------------------------------------------------

function DebouncedAutocomplete<T extends { id: string }>({
  value,
  onChange,
  placeholder,
  options,
  getOptionLabel,
  onSelect,
  debounceMs = DEBOUNCE_MS,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: T[];
  getOptionLabel: (opt: T) => string;
  onSelect: (opt: T) => void;
  debounceMs?: number;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const debouncedQuery = useDebouncedValue(value, debounceMs);
  const ref = React.useRef<HTMLDivElement>(null);
  const filtered = React.useMemo(
    () =>
      !debouncedQuery.trim()
        ? options
        : options.filter((o) =>
            getOptionLabel(o).toLowerCase().includes(debouncedQuery.toLowerCase())
          ),
    [options, debouncedQuery, getOptionLabel]
  );
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  return (
    <div ref={ref} className={cn('relative', className)}>
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {open && filtered.length > 0 && (
        <ul
          className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover py-1 shadow-soft-lg max-h-48 overflow-auto"
          role="listbox"
        >
          {filtered.slice(0, 8).map((opt) => (
            <li
              key={opt.id}
              role="option"
              aria-selected={false}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
              onClick={() => {
                onChange(getOptionLabel(opt));
                onSelect(opt);
                setOpen(false);
              }}
            >
              {getOptionLabel(opt)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Company search (API-backed)
// ---------------------------------------------------------------------------

function CompanySearchAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (company: CompanySearchResult) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const debouncedQuery = useDebouncedValue(value.trim(), DEBOUNCE_MS);
  const [options, setOptions] = React.useState<CompanySearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!debouncedQuery) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchCompanies(debouncedQuery)
      .then((list) => {
        if (!cancelled) setOptions(list);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const displayOptions = options.slice(0, 10);
  const showDropdown = open && (loading || displayOptions.length > 0);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? 'Search companies...'}
        disabled={disabled}
      />
      {showDropdown && (
        <ul
          className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover py-1 shadow-soft-lg max-h-48 overflow-auto"
          role="listbox"
        >
          {loading ? (
            <li className="px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching...
            </li>
          ) : (
            displayOptions.map((c) => (
              <li
                key={c.id}
                role="option"
                aria-selected={value === (c.name ?? c.id)}
                className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
                onClick={() => {
                  onChange(c.name ?? c.id);
                  onSelect(c);
                  setOpen(false);
                }}
              >
                {c.name ?? c.id}
                {c.domain ? (
                  <span className="text-muted-foreground ml-1 text-xs">({c.domain})</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right column: Contact search (search bar + results + view/edit/delete dialogs)
// ---------------------------------------------------------------------------

function ContactSearchPanel(): React.ReactElement {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = React.useState('');
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 400);

  const [infoDialogOpen, setInfoDialogOpen] = React.useState(false);
  const [selectedContact, setSelectedContact] = React.useState<ApiContact | null>(null);
  const [contactDetails, setContactDetails] = React.useState<ApiContact | null>(null);
  const [contactDetailsLoading, setContactDetailsLoading] = React.useState(false);
  const [deleteConfirmContact, setDeleteConfirmContact] = React.useState<ApiContact | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const [editDialogOpen, setEditDialogOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [jobTitle, setJobTitle] = React.useState('');
  const [accountId, setAccountId] = React.useState('');
  const [accountSearchDisplay, setAccountSearchDisplay] = React.useState('');
  const [relationshipStatus, setRelationshipStatus] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [contactSubmitLoading, setContactSubmitLoading] = React.useState(false);
  const [toast, setToast] = React.useState<{
    open: boolean;
    variant: 'success' | 'error' | 'default';
    title: string;
    description?: string;
  }>({ open: false, variant: 'default', title: '' });

  const showToast = (variant: 'success' | 'error', title: string, description?: string) => {
    setToast({ open: true, variant, title, description });
  };

  const contactsQuery = useQuery({
    queryKey: [CONTACTS_QUERY_KEY, debouncedSearch],
    queryFn: async () => {
      if (!debouncedSearch.trim()) return [];
      return searchContacts(debouncedSearch);
    },
  });

  const contacts = React.useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const isSearching = contactsQuery.isFetching && !!debouncedSearch;
  const contactError = contactsQuery.isError && contactsQuery.error
    ? (contactsQuery.error instanceof Error ? contactsQuery.error.message : 'Failed to load contacts')
    : null;

  const refreshContactList = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [CONTACTS_QUERY_KEY] });
  }, [queryClient]);

  const resetEditForm = () => {
    setEditingId(null);
    setFirstName(''); setLastName(''); setEmail(''); setPhone('');
    setJobTitle(''); setAccountId(''); setAccountSearchDisplay('');
    setRelationshipStatus(''); setNotes(''); setErrors({});
  };

  const loadContactIntoForm = (c: ApiContact) => {
    setEditingId(c.id);
    setFirstName(c.first_name ?? ''); setLastName(c.last_name ?? '');
    setEmail(c.email ?? ''); setPhone(c.phone ?? '');
    setJobTitle(c.job_title ?? ''); setAccountId(c.company_id ?? '');
    setAccountSearchDisplay(c.company_name ?? '');
    setRelationshipStatus(c.relationship_status ?? '');
    setNotes(c.notes ?? ''); setErrors({});
  };

  const openInfoDialog = (c: ApiContact) => {
    setSelectedContact(c); setContactDetails(null);
    setDeleteConfirmContact(null); setInfoDialogOpen(true);
    setContactDetailsLoading(true);
    getContact(c.id)
      .then((full) => setContactDetails(full))
      .catch(() => setContactDetails(c))
      .finally(() => setContactDetailsLoading(false));
  };

  const closeInfoDialog = () => {
    setInfoDialogOpen(false); setSelectedContact(null);
    setContactDetails(null); setDeleteConfirmContact(null);
  };

  const openEditDialog = (c: ApiContact) => {
    loadContactIntoForm(c);
    setInfoDialogOpen(false);
    setEditDialogOpen(true);
  };

  const closeEditDialog = () => {
    setEditDialogOpen(false);
    resetEditForm();
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    const fn = firstName.trim(); const ln = lastName.trim();
    const em = email.trim(); const ph = phone.trim();
    const next: Record<string, string> = {};
    if (!fn) next.firstName = 'First name is required';
    if (!ln) next.lastName = 'Last name is required';
    if (!em) next.email = 'Email is required';
    else if (!validateEmail(em)) next.email = 'Enter a valid email address';
    if (ph && !validatePhone(ph)) next.phone = 'Enter a valid phone number';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setContactSubmitLoading(true);
    try {
      await updateContact(editingId, {
        first_name: fn, last_name: ln, email: em,
        phone: ph || null, job_title: jobTitle.trim() || null,
        company_id: accountId || null,
        relationship_status: relationshipStatus || null,
        notes: notes.trim() || null,
      });
      showToast('success', 'Contact updated');
      await refreshContactList();
      closeEditDialog();
    } catch (err) {
      showToast('error', 'Failed to update contact', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setContactSubmitLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteContact(id);
      showToast('success', 'Contact deleted');
      await refreshContactList();
      setDeleteConfirmContact(null);
      closeInfoDialog();
    } catch (err) {
      showToast('error', 'Failed to delete contact', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-3 p-3 border-b border-border shrink-0">
      <div className="shrink-0">
        <h2 className="text-base font-semibold">Contact Search</h2>
      </div>
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          placeholder="Search by name, email, or company..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9"
          aria-label="Search contacts"
        />
      </div>

      {/* Results — fixed-height scrollable area so the list never pushes the email section off-screen */}
      {contactError && (
        <p className="text-sm text-status-at-risk" role="alert">{contactError}</p>
      )}
      {debouncedSearch.trim() ? (
        isSearching && contacts.length === 0 ? (
          <div className="flex items-center justify-center py-8 min-h-[200px]" aria-busy="true">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : contacts.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-0">
              <EmptyState icon={Users} title="No matches" description="Try a different search term." />
            </CardContent>
          </Card>
        ) : (
          <Card className="flex flex-col shrink-0">
            <CardHeader className="py-2.5 shrink-0">
              <CardTitle className="text-base">Results</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Click the info button to view, edit, or delete.</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-72 overflow-y-auto border-t border-border [scrollbar-gutter:stable]" aria-label="Contact search results">
                <ul className="divide-y divide-border">
                  {contacts.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-4 py-2 px-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">
                          {[c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed'}
                        </p>
                        <p className="text-sm text-muted-foreground truncate">{c.email ?? '—'}</p>
                        {c.company_name && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{c.company_name}</p>
                        )}
                      </div>
                      <Button
                        type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
                        onClick={() => openInfoDialog(c)}
                        aria-label={`View details for ${c.first_name ?? ''} ${c.last_name ?? ''}`}
                      >
                        <Info className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )
      ) : null}

      {/* Info dialog */}
      <Dialog open={infoDialogOpen} onOpenChange={(open) => !open && closeInfoDialog()}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" showClose={true}>
          <DialogHeader>
            <DialogTitle>Contact details</DialogTitle>
            <DialogDescription>
              {selectedContact ? [selectedContact.first_name, selectedContact.last_name].filter(Boolean).join(' ') || 'Unnamed' : ''}
            </DialogDescription>
          </DialogHeader>
          {selectedContact && !deleteConfirmContact && (() => {
            const display = contactDetails ?? selectedContact;
            return (
              <div className="space-y-4">
                {contactDetailsLoading ? (
                  <div className="flex items-center justify-center py-8" aria-busy="true">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 text-sm">
                    <div><span className="text-muted-foreground">Name</span><p className="font-medium">{[display.first_name, display.last_name].filter(Boolean).join(' ') || '—'}</p></div>
                    <div><span className="text-muted-foreground">Email</span><p className="font-medium">{display.email ?? '—'}</p></div>
                    {(display.mobile_phone ?? display.phone) ? (
                      <>
                        {display.mobile_phone && <div><span className="text-muted-foreground">Mobile</span><p className="font-medium">{display.mobile_phone}</p></div>}
                        <div><span className="text-muted-foreground">Phone</span><p className="font-medium">{display.phone ?? '—'}</p></div>
                      </>
                    ) : (
                      <div><span className="text-muted-foreground">Phone / Mobile</span><p className="font-medium">—</p></div>
                    )}
                    <div><span className="text-muted-foreground">Company</span><p className="font-medium">{display.company_name ?? display.company_id ?? '—'}</p></div>
                    <div><span className="text-muted-foreground">Job title</span><p className="font-medium">{display.job_title ?? '—'}</p></div>
                    {display.relationship_status && (
                      <div><span className="text-muted-foreground">Relationship</span><p className="font-medium"><StatusChip status={display.relationship_status as RelationshipStatus} size="sm" /></p></div>
                    )}
                    {display.notes && <div><span className="text-muted-foreground">Notes</span><p className="font-medium whitespace-pre-wrap">{display.notes}</p></div>}
                  </div>
                )}
                {!contactDetailsLoading && (
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => selectedContact && openEditDialog(selectedContact)}>
                      <Pencil className="h-4 w-4 mr-1" />Edit
                    </Button>
                    <Button type="button" variant="outline" className="text-status-at-risk hover:text-status-at-risk" onClick={() => setDeleteConfirmContact(selectedContact)}>
                      <Trash2 className="h-4 w-4 mr-1" />Delete
                    </Button>
                  </DialogFooter>
                )}
              </div>
            );
          })()}
          {selectedContact && deleteConfirmContact && (
            <div className="space-y-4">
              <p className="text-sm">Are you sure you want to delete{' '}
                <strong>{[deleteConfirmContact.first_name, deleteConfirmContact.last_name].filter(Boolean).join(' ') || 'this contact'}</strong>?
                This cannot be undone.
              </p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDeleteConfirmContact(null)}>No, keep</Button>
                <Button type="button" variant="destructive" onClick={() => handleDelete(deleteConfirmContact.id)} disabled={deletingId !== null}>
                  {deletingId === deleteConfirmContact.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Yes, delete
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" showClose={true}>
          <DialogHeader>
            <DialogTitle>Edit contact</DialogTitle>
            <DialogDescription>Update details below. Changes are saved to HubSpot when you click Save.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="sp-edit-firstName">First Name *</Label>
                <Input id="sp-edit-firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="mt-1" error={!!errors.firstName} />
                {errors.firstName && <p className="text-xs text-status-at-risk mt-1">{errors.firstName}</p>}
              </div>
              <div>
                <Label htmlFor="sp-edit-lastName">Last Name *</Label>
                <Input id="sp-edit-lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} className="mt-1" error={!!errors.lastName} />
                {errors.lastName && <p className="text-xs text-status-at-risk mt-1">{errors.lastName}</p>}
              </div>
            </div>
            <div>
              <Label htmlFor="sp-edit-email">Email *</Label>
              <Input id="sp-edit-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1" error={!!errors.email} />
              {errors.email && <p className="text-xs text-status-at-risk mt-1">{errors.email}</p>}
            </div>
            <div>
              <Label htmlFor="sp-edit-phone">Phone</Label>
              <Input id="sp-edit-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1" error={!!errors.phone} />
              {errors.phone && <p className="text-xs text-status-at-risk mt-1">{errors.phone}</p>}
            </div>
            <div>
              <Label htmlFor="sp-edit-jobTitle">Job Title</Label>
              <Input id="sp-edit-jobTitle" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Account</Label>
              <CompanySearchAutocomplete
                value={accountSearchDisplay || ''}
                onChange={(v) => { setAccountSearchDisplay(v); if (!v) setAccountId(''); }}
                onSelect={(c) => { setAccountId(c.id); setAccountSearchDisplay(c.name ?? c.id); }}
                placeholder="Search companies..."
                className="mt-1"
              />
            </div>
            <div>
              <Label>Relationship Status</Label>
              <Select value={relationshipStatus} onValueChange={setRelationshipStatus}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select status" /></SelectTrigger>
                <SelectContent>
                  {RELATIONSHIP_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className="flex items-center gap-2"><StatusChip status={s} size="sm" /></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="sp-edit-notes">Notes</Label>
              <Textarea id="sp-edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 min-h-[80px]" placeholder="Add notes..." />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeEditDialog} disabled={contactSubmitLoading}>Cancel</Button>
              <Button type="submit" disabled={contactSubmitLoading}>
                {contactSubmitLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Toast open={toast.open} onOpenChange={(open) => !open && setToast((p) => ({ ...p, open: false }))} variant={toast.variant}>
        <ToastTitle>{toast.title}</ToastTitle>
        {toast.description && <ToastDescription>{toast.description}</ToastDescription>}
        <ToastClose />
      </Toast>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right column: Import from communication (shared across Contact / Account tabs)
// ---------------------------------------------------------------------------

function ImportFromCommunicationColumn({
  onUseExtractedData,
}: {
  onUseExtractedData: (data: ExtractedContact) => void;
}): React.ReactElement {
  const [emailSearchQuery, setEmailSearchQuery] = React.useState('');
  const [emailSearchFolder, setEmailSearchFolder] = React.useState<GmailSearchFolder>('all');
  /** Optional date filter (YYYY-MM-DD). When set, only emails from that day are shown. */
  const [emailSearchDate, setEmailSearchDate] = React.useState<string>('');
  const [emailSearchResults, setEmailSearchResults] = React.useState<GmailSearchMessage[]>([]);
  const [emailSearchLoading, setEmailSearchLoading] = React.useState(false);
  /** Full result set for current query (folder=all). When user switches to Inbox/Sent we filter this instead of refetching. */
  const [emailSearchFullCache, setEmailSearchFullCache] = React.useState<GmailSearchMessage[] | null>(null);
  const [emailSearchFullCacheQuery, setEmailSearchFullCacheQuery] = React.useState('');
  const [emailSearchFullCacheDate, setEmailSearchFullCacheDate] = React.useState('');
  const [initialRecentEmails, setInitialRecentEmails] = React.useState<GmailSearchMessage[] | null>(null);
  const [initialRecentLoading, setInitialRecentLoading] = React.useState(false);
  const [selectedEmailForImport, setSelectedEmailForImport] = React.useState<GmailSearchMessage | null>(null);
  const [confirmSendOpen, setConfirmSendOpen] = React.useState(false);
  const [extractLoading, setExtractLoading] = React.useState(false);
  const [extractedData, setExtractedData] = React.useState<ExtractedContact | null>(null);
  const [extractedDialogOpen, setExtractedDialogOpen] = React.useState(false);
  const [gmailConnected, setGmailConnected] = React.useState<boolean | null>(null);
  const debouncedEmailQuery = useDebouncedValue(emailSearchQuery.trim(), 400);

  // Know if Gmail is connected so we can show "Connect Gmail" hint when no emails are due to missing connection.
  React.useEffect(() => {
    let cancelled = false;
    getGmailStatus()
      .then((data) => { if (!cancelled) setGmailConnected(data.connected); })
      .catch(() => { if (!cancelled) setGmailConnected(false); });
    return () => { cancelled = true; };
  }, []);

  // Load latest emails on mount and when date filter changes (no search query) so the results section is pre-populated.
  React.useEffect(() => {
    let cancelled = false;
    setInitialRecentLoading(true);
    gmailSearchEmails('', 'all', emailSearchDate || undefined)
      .then((list) => {
        if (!cancelled) setInitialRecentEmails(list);
      })
      .catch(() => {
        if (!cancelled) setInitialRecentEmails([]);
      })
      .finally(() => {
        if (!cancelled) setInitialRecentLoading(false);
      });
    return () => { cancelled = true; };
  }, [emailSearchDate]);

  // When there is no search query, show initial recent emails (filtered by All/Inbox/Sent).
  React.useEffect(() => {
    if (!debouncedEmailQuery) {
      setEmailSearchResults(filterMessagesByFolder(initialRecentEmails ?? [], emailSearchFolder));
      return;
    }
    const haveFullCacheForQuery =
      emailSearchFullCache !== null &&
      emailSearchFullCacheQuery === debouncedEmailQuery &&
      emailSearchFullCacheDate === emailSearchDate;
    if (haveFullCacheForQuery) {
      setEmailSearchResults(filterMessagesByFolder(emailSearchFullCache, emailSearchFolder));
      return;
    }
    let cancelled = false;
    setEmailSearchLoading(true);
    gmailSearchEmails(debouncedEmailQuery, 'all', emailSearchDate || undefined)
      .then((list) => {
        if (cancelled) return;
        setEmailSearchFullCache(list);
        setEmailSearchFullCacheQuery(debouncedEmailQuery);
        setEmailSearchFullCacheDate(emailSearchDate);
        setEmailSearchResults(filterMessagesByFolder(list, emailSearchFolder));
      })
      .catch(() => {
        if (!cancelled) {
          setEmailSearchResults([]);
          setEmailSearchFullCache(null);
          setEmailSearchFullCacheQuery('');
          setEmailSearchFullCacheDate('');
        }
      })
      .finally(() => {
        if (!cancelled) setEmailSearchLoading(false);
      });
    return () => { cancelled = true; };
  }, [debouncedEmailQuery, emailSearchFolder, emailSearchDate, emailSearchFullCache, emailSearchFullCacheQuery, emailSearchFullCacheDate, initialRecentEmails]);

  const handleSelectEmailForImport = (msg: GmailSearchMessage) => {
    setSelectedEmailForImport(msg);
    setConfirmSendOpen(true);
  };

  const handleConfirmSendForProcessing = async () => {
    if (!selectedEmailForImport) return;
    setExtractLoading(true);
    setConfirmSendOpen(false);
    try {
      const data = await gmailExtractContact(selectedEmailForImport.id);
      setExtractedData(data);
      setExtractedDialogOpen(true);
      setSelectedEmailForImport(null);
    } catch (_err) {
      // Error could be surfaced via toast if desired
    } finally {
      setExtractLoading(false);
    }
  };

  const handleUseExtractedData = () => {
    if (!extractedData) return;
    onUseExtractedData(extractedData);
    setExtractedDialogOpen(false);
    setExtractedData(null);
  };

  return (
    <div className="h-full min-h-0 flex flex-col p-3">
      <Card className="flex-1 min-h-0 flex flex-col">
        <CardHeader className="shrink-0 py-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Import from communication
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            Search your Gmail and import contact details from an email.
          </p>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 overflow-y-auto pt-0">
          <div className="space-y-2 pt-1">
            <div className="flex rounded-md border border-border p-0.5 bg-muted" role="group" aria-label="Search in">
              {(['all', 'inbox', 'sent'] as const).map((f) => (
                <Button
                  key={f}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`flex-1 rounded-sm text-xs font-medium capitalize ${emailSearchFolder === f ? '!bg-muted-foreground/25 !text-foreground font-semibold' : ''}`}
                  onClick={() => setEmailSearchFolder(f)}
                >
                  {f === 'all' ? 'All' : f === 'inbox' ? 'Inbox' : 'Sent'}
                </Button>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  placeholder="Search email by keywords..."
                  value={emailSearchQuery}
                  onChange={(e) => setEmailSearchQuery(e.target.value)}
                  className="pl-9"
                  aria-label="Search Gmail"
                />
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" aria-label="Filter by date" title="Show emails from this date">
                    <CalendarIcon className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    selected={emailSearchDate ? new Date(emailSearchDate + 'T00:00:00') : undefined}
                    onSelect={(d) => setEmailSearchDate(d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '')}
                  />
                </PopoverContent>
              </Popover>
            </div>
            {extractLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Analysing email...
              </div>
            )}
            {!extractLoading && (emailSearchLoading || (!debouncedEmailQuery && initialRecentLoading)) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2 border border-border rounded-md px-3">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching...
              </div>
            )}
            {!extractLoading && !(emailSearchLoading || (!debouncedEmailQuery && initialRecentLoading)) && emailSearchResults.length > 0 && (
              <ul
                className="border border-border rounded-md divide-y divide-border max-h-[320px] overflow-y-auto"
                aria-label="Email search results"
              >
                {emailSearchResults.map((msg) => (
                  <li key={msg.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors"
                      onClick={() => handleSelectEmailForImport(msg)}
                    >
                      <p className="font-medium text-sm truncate">{msg.subject || '(no subject)'}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{formatEmailDate(msg)}</p>
                      {(emailSearchFolder === 'all' || emailSearchFolder === 'inbox') && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          From: {msg.from || '—'}
                        </p>
                      )}
                      {(emailSearchFolder === 'all' || emailSearchFolder === 'sent') && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          To: {msg.to || '—'}
                        </p>
                      )}
                      {msg.snippet && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{msg.snippet}</p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!extractLoading && emailSearchResults.length === 0 && !emailSearchLoading && !initialRecentLoading && (
              gmailConnected === false ? (
                <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Connect your Gmail in Connection settings to search and import from your inbox.
                  </p>
                  <Button variant="outline" size="sm" className="gap-1.5" asChild>
                    <Link href="/integrations?expand=email">Connection settings → Email Inbox</Link>
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-2">
                  {debouncedEmailQuery ? 'No emails found. Try different keywords.' : 'No recent emails in this view.'}
                </p>
              )
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmSendOpen} onOpenChange={(open) => !open && (setConfirmSendOpen(false), setSelectedEmailForImport(null))}>
        <DialogContent className="max-w-md" showClose={true}>
          <DialogHeader>
            <DialogTitle>Send for processing?</DialogTitle>
            <DialogDescription>
              The selected email will be analysed by AI to extract contact and company details. Only subject, sender, and content are used.
            </DialogDescription>
          </DialogHeader>
          {selectedEmailForImport && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1">
              <p><span className="text-muted-foreground">From:</span> {selectedEmailForImport.from}</p>
              <p><span className="text-muted-foreground">Subject:</span> {selectedEmailForImport.subject || '(no subject)'}</p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (setConfirmSendOpen(false), setSelectedEmailForImport(null))}>
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirmSendForProcessing} disabled={extractLoading}>
              {extractLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={extractedDialogOpen} onOpenChange={(open) => !open && (setExtractedDialogOpen(false), setExtractedData(null))}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" showClose={true}>
          <DialogHeader>
            <DialogTitle>Recognised fields</DialogTitle>
            <DialogDescription>
              Review the extracted contact and company details, then use them to fill the contact form.
            </DialogDescription>
          </DialogHeader>
          {extractedData && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-2 text-sm">
                {([
                  ['First name', extractedData.first_name],
                  ['Last name', extractedData.last_name],
                  ['Email', extractedData.email],
                  ['Phone', extractedData.phone],
                  ['Job title', extractedData.job_title],
                  ['Company', extractedData.company_name],
                  ['Company domain', extractedData.company_domain],
                  ['City', extractedData.city],
                  ['State / Region', extractedData.state_region],
                  ['Company owner', extractedData.company_owner],
                ] as const).map(([label, value]) => (
                  <div key={label}>
                    <span className="text-muted-foreground">{label}:</span>{' '}
                    <span className="font-medium">{value || '—'}</span>
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => (setExtractedDialogOpen(false), setExtractedData(null))}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleUseExtractedData}>
                  Use extracted data
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contact tab
// ---------------------------------------------------------------------------

const CONTACTS_QUERY_KEY = 'contacts';

function ContactTabContent({
  addContactForm,
  setAddContactForm,
  extractedDataForCompanyPicker,
  onClearCompanyPicker,
}: {
  addContactForm: AddContactFormState;
  setAddContactForm: React.Dispatch<React.SetStateAction<AddContactFormState>>;
  extractedDataForCompanyPicker: ExtractedContact | null;
  onClearCompanyPicker: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [contactSubmitLoading, setContactSubmitLoading] = React.useState(false);
  const [companyMatchResults, setCompanyMatchResults] = React.useState<CompanySearchResult[]>([]);
  const [companyMatchLoading, setCompanyMatchLoading] = React.useState(false);
  const [toast, setToast] = React.useState<{
    open: boolean;
    variant: 'success' | 'error' | 'default';
    title: string;
    description?: string;
  }>({ open: false, variant: 'default', title: '' });

  const showToast = (variant: 'success' | 'error', title: string, description?: string) => {
    setToast({ open: true, variant, title, description });
  };

  const refreshContactList = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [CONTACTS_QUERY_KEY] });
  }, [queryClient]);

  React.useEffect(() => {
    if (!extractedDataForCompanyPicker) { setCompanyMatchResults([]); return; }
    const companyName = (extractedDataForCompanyPicker.company_name || '').trim();
    if (!companyName) { setCompanyMatchResults([]); return; }
    let cancelled = false;
    setCompanyMatchLoading(true);
    searchCompanies(companyName)
      .then((list) => { if (!cancelled) setCompanyMatchResults(list); })
      .catch(() => { if (!cancelled) setCompanyMatchResults([]); })
      .finally(() => { if (!cancelled) setCompanyMatchLoading(false); });
    return () => { cancelled = true; };
  }, [extractedDataForCompanyPicker]);

  const handleConfirmCompanyMatch = (c: CompanySearchResult) => {
    setAddContactForm((prev) => ({ ...prev, accountId: c.id, accountSearchDisplay: c.name ?? c.id }));
    setCompanyMatchResults([]);
    onClearCompanyPicker();
  };

  const handleCreateAccountFromImport = () => {
    const data = extractedDataForCompanyPicker;
    if (!data) return;
    const params = new URLSearchParams();
    params.set('tab', 'account'); params.set('returnToContact', '1');
    if (data.company_name) params.set('companyName', data.company_name);
    if (data.company_domain) params.set('domain', data.company_domain);
    if (data.city) params.set('city', data.city);
    if (data.state_region) params.set('stateRegion', data.state_region);
    if (data.company_owner) params.set('companyOwner', data.company_owner);
    setCompanyMatchResults([]);
    onClearCompanyPicker();
    router.replace(`/contacts?${params.toString()}`, { scroll: false });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const fn = addContactForm.firstName.trim(); const ln = addContactForm.lastName.trim();
    const em = addContactForm.email.trim(); const ph = addContactForm.phone.trim();
    const next: Record<string, string> = {};
    if (!fn) next.firstName = 'First name is required';
    if (!ln) next.lastName = 'Last name is required';
    if (!em) next.email = 'Email is required';
    else if (!validateEmail(em)) next.email = 'Enter a valid email address';
    if (ph && !validatePhone(ph)) next.phone = 'Enter a valid phone number';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setContactSubmitLoading(true);
    try {
      await createContact({
        first_name: fn, last_name: ln, email: em,
        phone: ph || null, job_title: addContactForm.jobTitle.trim() || null,
        company_id: addContactForm.accountId || null,
        relationship_status: addContactForm.relationshipStatus || null,
        notes: null,
      });
      showToast('success', 'Contact created');
      await refreshContactList();
      setAddContactForm(INITIAL_ADD_CONTACT_FORM);
    } catch (err) {
      showToast('error', 'Failed to create contact', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setContactSubmitLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Add contact card — stretches so bottom aligns with Import from communication card */}
      <div className="flex-1 min-h-0 flex flex-col">
        <Card className="h-full flex flex-col">
            <CardHeader className="shrink-0 py-3">
              <CardTitle className="text-base">Add contact</CardTitle>
              <p className="text-sm text-muted-foreground mt-0.5">
                Create a new contact. It will be added to HubSpot.
              </p>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 overflow-y-auto pt-0">
              <form onSubmit={handleCreate} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="firstName">First Name *</Label>
                    <Input
                      id="firstName"
                      value={addContactForm.firstName}
                      onChange={(e) => setAddContactForm((p) => ({ ...p, firstName: e.target.value }))}
                      className="mt-1"
                      error={!!errors.firstName}
                    />
                    {errors.firstName && (
                      <p className="text-xs text-status-at-risk mt-1">{errors.firstName}</p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="lastName">Last Name *</Label>
                    <Input
                      id="lastName"
                      value={addContactForm.lastName}
                      onChange={(e) => setAddContactForm((p) => ({ ...p, lastName: e.target.value }))}
                      className="mt-1"
                      error={!!errors.lastName}
                    />
                    {errors.lastName && (
                      <p className="text-xs text-status-at-risk mt-1">{errors.lastName}</p>
                    )}
                  </div>
                </div>
                <div>
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={addContactForm.email}
                    onChange={(e) => setAddContactForm((p) => ({ ...p, email: e.target.value }))}
                    className="mt-1"
                    error={!!errors.email}
                  />
                  {errors.email && (
                    <p className="text-xs text-status-at-risk mt-1">{errors.email}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={addContactForm.phone}
                    onChange={(e) => setAddContactForm((p) => ({ ...p, phone: e.target.value }))}
                    className="mt-1"
                    error={!!errors.phone}
                  />
                  {errors.phone && (
                    <p className="text-xs text-status-at-risk mt-1">{errors.phone}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="jobTitle">Job Title</Label>
                  <Input
                    id="jobTitle"
                    value={addContactForm.jobTitle}
                    onChange={(e) => setAddContactForm((p) => ({ ...p, jobTitle: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Account</Label>
                  <CompanySearchAutocomplete
                    value={addContactForm.accountSearchDisplay}
                    onChange={(v) => {
                      setAddContactForm((p) => ({ ...p, accountSearchDisplay: v, ...(v ? {} : { accountId: '' }) }));
                    }}
                    onSelect={(c) => {
                      setAddContactForm((p) => ({
                        ...p,
                        accountId: c.id,
                        accountSearchDisplay: c.name ?? c.id,
                      }));
                    }}
                    placeholder="Search companies..."
                    className="mt-1"
                  />
                  <Button
                    type="button"
                    variant="link"
                    className="mt-1.5 h-auto p-0 text-sm text-primary"
                    onClick={() => router.replace('/contacts?tab=account&returnToContact=1')}
                  >
                    + Create account
                  </Button>
                </div>
                <div>
                  <Label>Relationship Status</Label>
                  <Select
                    value={addContactForm.relationshipStatus}
                    onValueChange={(v) => setAddContactForm((p) => ({ ...p, relationshipStatus: v }))}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {RELATIONSHIP_OPTIONS.map((s) => (
                        <SelectItem key={s} value={s}>
                          <span className="flex items-center gap-2">
                            <StatusChip status={s} size="sm" />
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCreate}
                    disabled={contactSubmitLoading}
                  >
                    {contactSubmitLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Create Contact
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>

      {/* Company match picker (after "Use extracted data" from Import column) */}
      {extractedDataForCompanyPicker && (
        <Card className="border-status-warm/30">
          <CardHeader className="py-2.5">
            <CardTitle className="text-sm">Match account</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Select a company to associate with this contact, or create a new one.
            </p>
          </CardHeader>
          <CardContent className="pt-0 pb-3">
            {companyMatchLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching companies...
              </div>
            ) : companyMatchResults.length > 0 ? (
              <ul className="space-y-2">
                {companyMatchResults.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-2 border-b border-border last:border-0">
                    <span className="text-sm truncate">{c.name ?? c.id}{c.domain ? ` (${c.domain})` : ''}</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => handleConfirmCompanyMatch(c)}>
                      Confirm
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">No matching company in HubSpot.</p>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleCreateAccountFromImport}
                  className="font-medium"
                >
                  Create account
                </Button>
                <p className="text-xs text-muted-foreground">Company details from the email will be pre-filled.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Toast
        open={toast.open}
        onOpenChange={(open) => !open && setToast((p) => ({ ...p, open: false }))}
        variant={toast.variant}
      >
        <ToastTitle>{toast.title}</ToastTitle>
        {toast.description && <ToastDescription>{toast.description}</ToastDescription>}
        <ToastClose />
      </Toast>
    </div>  );
}

// ---------------------------------------------------------------------------
// Account tab
// ---------------------------------------------------------------------------

function AccountTabContent({
  returnToContact,
  onCreateAndGoBack,
  prefillCompanyName,
  prefillDomain,
  prefillCity,
  prefillStateRegion,
  prefillCompanyOwner,
}: {
  returnToContact: boolean;
  onCreateAndGoBack: (company: { id: string; name: string }) => void;
  prefillCompanyName?: string;
  prefillDomain?: string;
  prefillCity?: string;
  prefillStateRegion?: string;
  prefillCompanyOwner?: string;
}): React.ReactElement {
  const [companyName, setCompanyName] = React.useState(prefillCompanyName ?? '');
  const [domain, setDomain] = React.useState(prefillDomain ?? '');
  const [companyOwner, setCompanyOwner] = React.useState(prefillCompanyOwner ?? '');
  const [city, setCity] = React.useState(prefillCity ?? '');
  const [stateRegion, setStateRegion] = React.useState(prefillStateRegion ?? '');
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (prefillCompanyName != null) setCompanyName(prefillCompanyName);
    if (prefillDomain != null) setDomain(prefillDomain);
    if (prefillCity != null) setCity(prefillCity);
    if (prefillStateRegion != null) setStateRegion(prefillStateRegion);
    if (prefillCompanyOwner != null) setCompanyOwner(prefillCompanyOwner);
  }, [prefillCompanyName, prefillDomain, prefillCity, prefillStateRegion, prefillCompanyOwner]);
  const [accountSubmitLoading, setAccountSubmitLoading] = React.useState(false);
  const [toast, setToast] = React.useState<{
    open: boolean;
    variant: 'success' | 'error' | 'default';
    title: string;
    description?: string;
  }>({ open: false, variant: 'default', title: '' });

  const showToast = (variant: 'success' | 'error', title: string, description?: string) => {
    setToast({ open: true, variant, title, description });
  };

  const resetAccountForm = () => {
    setCompanyName('');
    setDomain('');
    setCompanyOwner('');
    setCity('');
    setStateRegion('');
    setErrors({});
  };

  const buildPayload = (): { name: string; domain: string; city?: string; state?: string; company_owner?: string } => {
    return {
      name: companyName.trim(),
      domain: domain.trim(),
      ...(city.trim() && { city: city.trim() }),
      ...(stateRegion.trim() && { state: stateRegion.trim() }),
      ...(companyOwner.trim() && { company_owner: companyOwner.trim() }),
    };
  };

  const submitAccount = async (): Promise<CompanyDetailResponse | null> => {
    const next: Record<string, string> = {};
    if (!companyName.trim()) next.companyName = 'Company name is required';
    if (!domain.trim()) next.domain = 'Domain is required';
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    setAccountSubmitLoading(true);
    try {
      const created = await createCompany(buildPayload());
      showToast('success', 'Account created');
      resetAccountForm();
      return created;
    } catch (err) {
      showToast(
        'error',
        'Failed to create account',
        err instanceof Error ? err.message : 'Please try again.'
      );
      return null;
    } finally {
      setAccountSubmitLoading(false);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitAccount();
  };

  const handleCreateAndGoBack = async (e: React.FormEvent) => {
    e.preventDefault();
    const created = await submitAccount();
    if (created) {
      onCreateAndGoBack({ id: created.id, name: created.name ?? created.id });
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4">
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">Account details</CardTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create a company in HubSpot. Company name and domain are required.
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <form onSubmit={(e) => e.preventDefault()} className="space-y-3">
            <div>
              <Label htmlFor="companyName">Company Name *</Label>
              <Input
                id="companyName"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="mt-1"
                error={!!errors.companyName}
              />
              {errors.companyName && (
                <p className="text-xs text-status-at-risk mt-1">{errors.companyName}</p>
              )}
            </div>
            <div>
              <Label htmlFor="domain">Domain *</Label>
              <Input
                id="domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                className="mt-1"
                error={!!errors.domain}
              />
              {errors.domain && (
                <p className="text-xs text-status-at-risk mt-1">{errors.domain}</p>
              )}
            </div>
            <div>
              <Label htmlFor="companyOwner">Company Owner</Label>
              <Input
                id="companyOwner"
                value={companyOwner}
                onChange={(e) => setCompanyOwner(e.target.value)}
                placeholder="HubSpot owner ID or email"
                className="mt-1"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="stateRegion">State / Region</Label>
                <Input
                  id="stateRegion"
                  value={stateRegion}
                  onChange={(e) => setStateRegion(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                onClick={handleCreateAccount}
                disabled={accountSubmitLoading}
              >
                {accountSubmitLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Create Account
              </Button>
              {returnToContact && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCreateAndGoBack}
                  disabled={accountSubmitLoading}
                >
                  Create and go back to contact creation
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Toast
        open={toast.open}
        onOpenChange={(open) => !open && setToast((p) => ({ ...p, open: false }))}
        variant={toast.variant}
      >
        <ToastTitle>{toast.title}</ToastTitle>
        {toast.description && <ToastDescription>{toast.description}</ToastDescription>}
        <ToastClose />
      </Toast>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page content (uses useSearchParams — must be inside Suspense)
// ---------------------------------------------------------------------------

function ContactsPageContent(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam === 'account' ? 'account' : 'contact';
  const returnToContact = searchParams.get('returnToContact') === '1';

  const [addContactForm, setAddContactForm] = React.useState<AddContactFormState>(INITIAL_ADD_CONTACT_FORM);
  const [extractedDataForCompanyPicker, setExtractedDataForCompanyPicker] = React.useState<ExtractedContact | null>(null);

  const handleUseExtractedDataFromImport = React.useCallback((data: ExtractedContact) => {
    setAddContactForm((prev) => ({
      ...prev,
      firstName: data.first_name || prev.firstName,
      lastName: data.last_name || prev.lastName,
      email: data.email || prev.email,
      phone: data.phone || prev.phone,
      jobTitle: data.job_title || prev.jobTitle,
      accountSearchDisplay: data.company_name || prev.accountSearchDisplay,
      accountId: '',
    }));
    setExtractedDataForCompanyPicker(data);
    router.replace('/contacts?tab=contact', { scroll: false });
  }, [router]);

  const handleCreateAndGoBack = React.useCallback(
    (company: { id: string; name: string }) => {
      setAddContactForm((prev) => ({
        ...prev,
        accountId: company.id,
        accountSearchDisplay: company.name,
      }));
      router.replace('/contacts?tab=contact', { scroll: false });
    },
    [router]
  );

  const handleTabChange = React.useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', value);
      if (value !== 'account') params.delete('returnToContact');
      router.replace(`/contacts?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <header className="shrink-0">
        <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Create and manage contacts and accounts.
        </p>
      </header>

      {/* Two columns — each scrolls independently; whole page does not scroll */}
      <div className="flex-1 min-h-0 flex overflow-hidden gap-0 mt-3">

        {/* Left column (50%): tab switcher (static) + tab content (scrolls) */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden border-r border-border">
          <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full min-h-0">

            {/* Static header — tab switcher only, never scrolls */}
            <div className="shrink-0 px-4 py-2.5 border-b border-border">
              <TabsList className="w-full grid grid-cols-2 bg-muted">
                <TabsTrigger
                  value="contact"
                  className="data-[state=active]:bg-muted-foreground/25 data-[state=active]:text-foreground data-[state=active]:font-semibold data-[state=active]:shadow-sm"
                >
                  Contact
                </TabsTrigger>
                <TabsTrigger
                  value="account"
                  className="data-[state=active]:bg-muted-foreground/25 data-[state=active]:text-foreground data-[state=active]:font-semibold data-[state=active]:shadow-sm"
                >
                  Account
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 min-h-0 flex flex-col overflow-y-auto [scrollbar-gutter:stable]">
              <TabsContent value="contact" className="p-3 mt-0 flex-1 flex flex-col min-h-0 data-[state=inactive]:hidden">
                <ContactTabContent
                  addContactForm={addContactForm}
                  setAddContactForm={setAddContactForm}
                  extractedDataForCompanyPicker={extractedDataForCompanyPicker}
                  onClearCompanyPicker={() => setExtractedDataForCompanyPicker(null)}
                />
              </TabsContent>
              <TabsContent value="account" className="p-3 mt-0 flex-1 flex flex-col min-h-0 data-[state=inactive]:hidden">
                <AccountTabContent
                  returnToContact={returnToContact}
                  onCreateAndGoBack={handleCreateAndGoBack}
                  prefillCompanyName={searchParams.get('companyName') ?? undefined}
                  prefillDomain={searchParams.get('domain') ?? undefined}
                  prefillCity={searchParams.get('city') ?? undefined}
                  prefillStateRegion={searchParams.get('stateRegion') ?? undefined}
                  prefillCompanyOwner={searchParams.get('companyOwner') ?? undefined}
                />
              </TabsContent>
            </div>

          </Tabs>
        </div>

        {/* Right column (50%): contact search + import from communication; whole column scrolls, page stays static */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto bg-surface [scrollbar-gutter:stable]">
          <div className="flex flex-col min-h-min">
            <ContactSearchPanel />
            <div className="min-h-[420px] flex flex-col">
              <ImportFromCommunicationColumn onUseExtractedData={handleUseExtractedDataFromImport} />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page (wraps content in Suspense for useSearchParams)
// ---------------------------------------------------------------------------

function ContactsPageFallback(): React.ReactElement {
  return (
    <div className="flex items-center justify-center min-h-[200px]" aria-busy="true">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}

export default function ContactsPage(): React.ReactElement {
  return (
    <ProtectedRoute>
      <Suspense fallback={<ContactsPageFallback />}>
        <ContactsPageContent />
      </Suspense>
    </ProtectedRoute>
  );
}
