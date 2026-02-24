import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { Providers } from './providers';
import { ToastWrapper } from './toast-wrapper';
import { AppShell } from './app-shell';

export const metadata: Metadata = {
  title: 'HubSpot AI Wrapper',
  description: 'Full-stack HubSpot AI Wrapper application',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <Providers>
          <AuthProvider>
            <ToastWrapper>
              <AppShell>{children}</AppShell>
            </ToastWrapper>
          </AuthProvider>
        </Providers>
      </body>
    </html>
  );
}
