/** Use the browser favicon itself so every product surface shares one identity. */
export function ProductLogo({ className }: { className?: string }) {
  return <img className={className} src={document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href} alt="" aria-hidden="true" />;
}
