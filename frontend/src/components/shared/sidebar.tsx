'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FileText,
  Users,
  Plug,
  Settings,
  User,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SETTINGS_PAGE_ENABLED } from '@/lib/features';
import { useAuth } from '@/contexts/AuthContext';

function getInitials(name: string | null | undefined): string {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

const ALL_NAV_ITEMS: { path: string; label: string; icon: LucideIcon }[] = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/activity', label: 'Activity', icon: FileText },
  { path: '/contacts', label: 'Contacts', icon: Users },
  { path: '/integrations', label: 'Integrations', icon: Plug },
  { path: '/settings', label: 'Settings', icon: Settings },
];

const NAV_ITEMS = SETTINGS_PAGE_ENABLED
  ? ALL_NAV_ITEMS
  : ALL_NAV_ITEMS.filter((item) => item.path !== '/settings');

export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  className?: string;
  /** Called when a nav link is clicked (e.g. to close mobile menu) */
  onClose?: () => void;
}

const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(
  ({ className, onClose, ...props }, ref) => {
    const pathname = usePathname();
    const { user, signOut } = useAuth();
    const displayName = user?.user_metadata?.full_name ?? null;
    const email = user?.email ?? null;
    const initials = getInitials(displayName);

    return (
      <aside
        ref={ref}
        className={cn(
          'fixed left-0 top-0 z-40 flex h-screen w-[72px] flex-col border-r border-white/10 bg-[#1e293b]',
          className
        )}
        {...props}
      >
        <TooltipProvider delayDuration={0}>
          <nav
            className="flex flex-1 flex-col items-center gap-1 py-4"
            aria-label="Main"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('a')) onClose?.();
            }}
          >
            {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
              const isActive = pathname === path;
              return (
                <Tooltip key={path}>
                  <TooltipTrigger asChild>
                    <Link
                      href={path}
                      className={cn(
                        'flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg text-white/80 transition-colors',
                        'hover:bg-white/10 hover:text-white',
                        isActive && 'bg-[#3b82f6] text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
                      )}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={label}
                    >
                      <Icon className="h-6 w-6" aria-hidden />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={12}>
                    {label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

          {/* Profile at bottom */}
          {user && (
            <div
              className="flex flex-shrink-0 flex-col items-center border-t border-white/10 py-4"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a')) onClose?.();
              }}
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    'flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border border-white text-white/80 transition-colors',
                    'hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1e293b]'
                  )}
                  aria-label="Open profile menu"
                >
                  {initials !== '?' ? (
                    <span className="text-sm font-medium" aria-hidden>
                      {initials}
                    </span>
                  ) : (
                    <User className="h-6 w-6" aria-hidden />
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="right" sideOffset={12} className="w-[16.8rem] min-w-[16.8rem] p-3">
                  {displayName && (
                    <div className="px-2.5 py-2 text-[15px] font-medium text-foreground">
                      {displayName}
                    </div>
                  )}
                  {email && (
                    <div className="px-2.5 py-0.5 text-[13px] text-muted-foreground truncate">
                      {email}
                    </div>
                  )}
                  {(displayName || email) && <DropdownMenuSeparator />}
                  {SETTINGS_PAGE_ENABLED && (
                    <>
                      <DropdownMenuItem asChild className="py-2.5 text-[15px]">
                        <Link href="/settings" className="flex cursor-pointer items-center gap-2">
                          <User className="h-4 w-4" />
                          Profile
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild className="py-2.5 text-[15px]">
                        <Link href="/settings" className="flex cursor-pointer items-center gap-2">
                          <Settings className="h-4 w-4" />
                          Settings
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem
                    className="flex cursor-pointer items-center gap-2 py-2.5 text-[15px] text-destructive focus:text-destructive focus:bg-destructive/10"
                    onSelect={(e) => {
                      e.preventDefault();
                      signOut?.();
                    }}
                  >
                    <LogOut className="h-4 w-4" />
                    Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </TooltipProvider>
      </aside>
    );
  }
);
Sidebar.displayName = 'Sidebar';

export { Sidebar };
