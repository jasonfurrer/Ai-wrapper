'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search, User, Settings, LogOut, Menu } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SETTINGS_PAGE_ENABLED } from '@/lib/features';

function getInitials(name: string | null | undefined): string {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export interface TopbarUser {
  name?: string | null;
  email?: string | null;
}

export interface TopbarProps extends React.HTMLAttributes<HTMLElement> {
  user?: TopbarUser | null;
  onSignOut?: () => void;
  searchPlaceholder?: string;
  /** When set, shows a hamburger menu button (for mobile) that calls this on click */
  onMenuClick?: () => void;
  className?: string;
}

const Topbar = React.forwardRef<HTMLElement, TopbarProps>(
  (
    {
      user,
      onSignOut,
      searchPlaceholder = 'Search activities, contacts...',
      onMenuClick,
      className,
      ...props
    },
    ref
  ) => {
    const initials = getInitials(user?.name ?? null);

    return (
      <header
        ref={ref}
        className={cn(
          'sticky top-0 z-30 flex h-16 flex-row items-center gap-4 border-b border-border bg-white px-4',
          className
        )}
        {...props}
      >
        {/* Hamburger (mobile only) */}
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="md:hidden flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        {/* Search */}
        <div className="relative flex-1 min-w-0 max-w-[500px]">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder={searchPlaceholder}
            className="h-10 pl-9 border-border focus-visible:ring-status-active/30 focus-visible:ring-2"
            aria-label="Search"
          />
        </div>

        {/* User profile dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm font-medium text-foreground outline-none transition-colors',
              'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
            aria-label="Open user menu"
          >
            {initials !== '?' ? (
              <span aria-hidden>{initials}</span>
            ) : (
              <User className="h-4 w-4" aria-hidden />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {user?.name && (
              <div className="px-2 py-1.5 text-sm font-medium text-foreground">
                {user.name}
              </div>
            )}
            {user?.email && (
              <div className="px-2 py-0 text-xs text-muted-foreground truncate">
                {user.email}
              </div>
            )}
            {(user?.name || user?.email) && <DropdownMenuSeparator />}
            {SETTINGS_PAGE_ENABLED && (
              <>
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="flex cursor-pointer items-center gap-2">
                    <User className="h-4 w-4" />
                    Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="flex cursor-pointer items-center gap-2">
                    <Settings className="h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem
              className="flex cursor-pointer items-center gap-2 text-status-at-risk focus:text-status-at-risk"
              onSelect={(e) => {
                e.preventDefault();
                onSignOut?.();
              }}
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
    );
  }
);
Topbar.displayName = 'Topbar';

export { Topbar };
