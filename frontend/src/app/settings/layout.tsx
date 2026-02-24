import { redirect } from 'next/navigation';
import { SETTINGS_PAGE_ENABLED } from '@/lib/features';

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!SETTINGS_PAGE_ENABLED) {
    redirect('/dashboard');
  }
  return <>{children}</>;
}
