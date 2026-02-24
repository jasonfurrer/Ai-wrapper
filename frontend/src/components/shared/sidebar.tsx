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
  type LucideIcon,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { SETTINGS_PAGE_ENABLED } from '@/lib/features';

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
        </TooltipProvider>
      </aside>
    );
  }
);
Sidebar.displayName = 'Sidebar';

export { Sidebar };
