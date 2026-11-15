import React from 'react';
import { cn } from '../utils';
import { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  subtitle?: string | React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  backButton?: React.ReactNode;
  isScrolled?: boolean;
  compact?: boolean;
  className?: string;
  maxWidth?: string;
  children?: React.ReactNode; // For search/filters
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  icon: Icon,
  actions,
  backButton,
  isScrolled,
  compact = false,
  className,
  maxWidth = "max-w-[1600px]",
  children
}) => {
  return (
    <header className={cn(
      "flex-shrink-0 border-b border-slate-200 z-30 transition-all duration-500 ease-in-out group sticky top-0",
      isScrolled 
        ? "shadow-lg backdrop-blur-md bg-white/80" 
        : "shadow-sm bg-white",
      compact && "cn-page-header",
      className
    )}>
      <div className={cn(
        "mx-auto px-4 md:px-8 transition-all duration-500 ease-in-out",
        maxWidth,
        compact ? "py-4" : isScrolled ? "py-2 group-hover:py-6" : "py-6"
      )}>
        <div className={cn(
          "flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all duration-500",
          compact ? (children ? "mb-4" : "mb-0") : isScrolled ? "mb-1 group-hover:mb-6" : "mb-6"
        )}>
          <div className="flex items-center gap-4">
            {backButton && (
              <div className="flex-shrink-0">
                {backButton}
              </div>
            )}
            {Icon && (
              <div className={cn(
                "w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center transition-all duration-500",
                compact ? "cn-header-icon size-8" : isScrolled ? "w-8 h-8 group-hover:w-12 group-hover:h-12" : "w-12 h-12"
              )}>
                <Icon className={cn(
                  "transition-all duration-500",
                  compact ? "size-4" : isScrolled ? "w-4 h-4 group-hover:w-6 group-hover:h-6" : "w-6 h-6"
                )} />
              </div>
            )}
            <div>
              <h1 className={cn(
                "font-bold text-slate-900 tracking-tight transition-all duration-500",
                compact ? "text-xl sm:text-2xl" : isScrolled ? "text-lg group-hover:text-3xl" : "text-3xl"
              )}>
                {title}
              </h1>
              {subtitle && (
                <div className={cn(
                  "flex items-center gap-2 text-slate-500 transition-all duration-500 overflow-hidden ease-in-out",
                  isScrolled 
                    ? "h-0 opacity-0 group-hover:h-5 group-hover:opacity-100 group-hover:mt-1" 
                    : "h-5 opacity-100 mt-1"
                )}>
                  {subtitle}
                </div>
              )}
            </div>
          </div>
          {actions && (
            <div className={cn(
              "flex flex-wrap items-center gap-3 transition-all duration-500",
              !compact && isScrolled ? "scale-90 origin-right group-hover:scale-100" : ""
            )}>
              {actions}
            </div>
          )}
        </div>
        
        {children && (
          <div className={cn(
            "transition-all duration-500 ease-in-out origin-top",
            !compact && isScrolled
              ? "h-0 opacity-0 pointer-events-none group-hover:h-auto group-hover:opacity-100 group-hover:pointer-events-auto group-hover:mt-4" 
              : "h-auto opacity-100 mt-0"
          )}>
            {children}
          </div>
        )}
      </div>
    </header>
  );
};
