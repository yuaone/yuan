# React SSR/Hydration Expert Skill

## Identity
- domain: react
- type: ssr
- confidence: 0.85
- persona: Senior full-stack React engineer with deep expertise in server-side rendering, Next.js App Router and Pages Router, React Server Components, streaming SSR, and hydration debugging. Understands the React fiber reconciliation process during hydration and the boundary between server and client execution.

## Known Error Patterns

### 1. Hydration Mismatch — Client-Only APIs
- **symptoms**:
  - "Text content does not match server-rendered HTML"
  - "Hydration failed because the initial UI does not match"
  - Content flickers on page load
  - Different content shown before and after JavaScript loads
  - "There was an error while hydrating" with full client re-render
- **causes**:
  - Direct access to `window`, `document`, `navigator`, `localStorage` in render
  - `typeof window !== 'undefined'` check causing different output on server vs client
  - `Date.now()`, `new Date().toLocaleString()` producing different values
  - `Math.random()` in render path
  - `navigator.userAgent` conditional rendering
  - Third-party scripts/components that assume browser environment
- **strategy**:
  1. Move client-only code into `useEffect`: renders null/placeholder on server, real content on client
  2. Create `useIsClient` hook:
     ```
     function useIsClient() {
       const [isClient, setIsClient] = useState(false);
       useEffect(() => setIsClient(true), []);
       return isClient;
     }
     ```
  3. Use `next/dynamic` with `{ ssr: false }` for entire components that need browser APIs
  4. Use `suppressHydrationWarning` only for intentional mismatches (timestamps, user-specific content)
  5. For dates, render a stable format on server and enhance on client
  6. Wrap browser-API-dependent libraries in a client-only wrapper component
- **tools**: grep, file_read, file_edit, shell_exec
- **pitfalls**:
  - `typeof window` checks in render cause hydration mismatches -- the check itself produces different branches
  - `suppressHydrationWarning` only works on the direct element, not children
  - Over-using `ssr: false` defeats the purpose of SSR -- only for truly client-only components

### 2. useEffect vs useLayoutEffect in SSR
- **symptoms**:
  - "useLayoutEffect does nothing on the server" warning
  - Flash of unstyled content (FOUC)
  - Layout shift after hydration
  - Measurements (getBoundingClientRect) returning 0 on server
- **causes**:
  - `useLayoutEffect` runs synchronously after DOM mutations -- not possible on server
  - Using `useLayoutEffect` for client-side layout measurements
  - CSS-in-JS libraries using `useLayoutEffect` for style injection
  - Animation libraries using `useLayoutEffect` for initial measurements
- **strategy**:
  1. Use `useEffect` for most cases -- runs after paint, works on server
  2. Create `useIsomorphicLayoutEffect`:
     ```
     const useIsomorphicLayoutEffect =
       typeof window !== 'undefined' ? useLayoutEffect : useEffect;
     ```
  3. Only use `useLayoutEffect` when you need synchronous DOM measurement before paint
  4. For CSS-in-JS, ensure server-side style extraction is configured (styled-components: `ServerStyleSheet`)
  5. Accept minor layout shift vs. blocking paint -- `useEffect` is usually better for UX
- **tools**: grep, file_read, file_edit
- **pitfalls**:
  - The `useIsomorphicLayoutEffect` pattern is a workaround, not a solution -- consider if you really need layout effect
  - `useLayoutEffect` blocks paint -- use sparingly, even on client
  - Most "layout" needs can be handled with CSS (grid, flexbox) without JS measurement

### 3. Server Components vs Client Components (Next.js 13+)
- **symptoms**:
  - "You're importing a component that needs useState/useEffect. It only works in a Client Component"
  - "async/await is not yet supported in Client Components"
  - Props serialization errors ("only plain objects can be passed to Client Components")
  - "Functions cannot be passed directly to Client Components unless you explicitly expose it"
  - Import errors when mixing server and client components
- **causes**:
  - Using hooks (`useState`, `useEffect`, `useContext`) in a Server Component
  - Using event handlers (`onClick`, `onChange`) in a Server Component
  - Using browser-only APIs in a Server Component
  - Passing non-serializable props (functions, classes, Dates) from Server to Client Component
  - Importing a Client Component into a Server Component without `'use client'` boundary
- **strategy**:
  1. Add `'use client'` directive at the top of files that need hooks, events, or browser APIs
  2. Keep Server Components as the default -- only add `'use client'` when needed
  3. Push `'use client'` boundary as low as possible in the tree
  4. For non-serializable props, restructure: pass IDs instead of objects, use server actions
  5. Use the "donut pattern": Server Component wraps Client Component which wraps Server Component (via children)
  6. Server Components can import Client Components, but not vice versa (except via children)
  7. Fetch data in Server Components, pass serializable data to Client Components
- **tools**: grep, file_read, file_edit
- **pitfalls**:
  - `'use client'` does NOT make it client-only -- it creates a boundary. The component still renders on server for SSR
  - Do NOT add `'use client'` to a layout file unless absolutely necessary -- it opts out all children from Server Components
  - `'use server'` is for Server Actions (mutations), NOT for making a Server Component

### 4. Dynamic Imports and Code Splitting
- **symptoms**:
  - Large initial bundle size
  - Slow Time to Interactive (TTI)
  - Components that only show on interaction loaded upfront
  - SSR errors from client-only libraries
  - Flash of loading state on navigation
- **causes**:
  - All components loaded eagerly in the initial bundle
  - Heavy libraries (charts, editors, maps) included in server bundle
  - No code splitting for route-level or feature-level components
  - Client-only libraries imported at top level
- **strategy**:
  1. Use `next/dynamic` for heavy or client-only components:
     ```
     const Chart = dynamic(() => import('./Chart'), {
       loading: () => <ChartSkeleton />,
       ssr: false,
     });
     ```
  2. Use `React.lazy` + `Suspense` for CSR-only apps:
     ```
     const LazyComponent = React.lazy(() => import('./Heavy'));
     <Suspense fallback={<Skeleton />}><LazyComponent /></Suspense>
     ```
  3. Route-level code splitting is automatic in Next.js App Router
  4. Use `loading.tsx` files for route-level loading UI in App Router
  5. For shared layouts, use route groups `(group)` to avoid unnecessary re-renders
  6. Analyze bundle with `@next/bundle-analyzer` to identify split opportunities
- **tools**: file_read, file_edit, shell_exec, grep
- **pitfalls**:
  - `React.lazy` does NOT work with SSR -- use `next/dynamic` in Next.js
  - Do NOT lazy-load components that appear above the fold -- they should be in the initial bundle
  - `ssr: false` means the component renders nothing until JS loads -- bad for SEO-critical content

### 5. Streaming SSR Patterns
- **symptoms**:
  - Slow Time to First Byte (TTFB)
  - Entire page blocks on slowest data fetch
  - Users see blank page until all data loads
  - Waterfall data fetching pattern
  - Long server response times
- **causes**:
  - All data fetched before any HTML is sent (`getServerSideProps` blocking pattern)
  - No Suspense boundaries to enable streaming
  - Monolithic page component that needs all data at once
  - Database queries running sequentially instead of in parallel
- **strategy**:
  1. Use Suspense boundaries to stream parts of the page:
     ```
     <Suspense fallback={<HeaderSkeleton />}>
       <Header />
     </Suspense>
     <Suspense fallback={<ContentSkeleton />}>
       <SlowContent />  <!-- Streams in when ready -->
     </Suspense>
     ```
  2. In App Router, use `async` Server Components with Suspense for streaming
  3. Run independent data fetches in parallel with `Promise.all`
  4. Use `loading.tsx` for route-level streaming boundaries
  5. Critical content (header, hero) should be fast -- wrap slow content in Suspense
  6. Use `generateStaticParams` for static generation when data is known at build time
  7. Consider ISR (Incremental Static Regeneration) with `revalidate` for semi-static pages
- **tools**: file_read, file_edit, shell_exec
- **pitfalls**:
  - Streaming only works with Node.js runtime, not Edge runtime for all cases
  - Too many Suspense boundaries can cause visual "popcorn" effect -- group related content
  - `loading.tsx` applies to the entire route segment -- be intentional about placement

### 6. Data Fetching in Server Components
- **symptoms**:
  - Using `useEffect` for data fetching in App Router
  - Unnecessary client-side waterfalls
  - Duplicate requests (server + client fetching same data)
  - Stale data issues with client-side caching
  - N+1 query patterns
- **causes**:
  - Migrating Pages Router patterns to App Router without adaptation
  - Not leveraging Server Component data fetching
  - Missing Request Memoization (same URL fetched multiple times in same request)
  - Not using `cache()` for database queries
- **strategy**:
  1. Fetch data directly in Server Components (no hooks needed):
     ```
     async function UserPage({ params }) {
       const user = await getUser(params.id);  // runs on server
       return <UserProfile user={user} />;
     }
     ```
  2. Use `cache()` from React for request-level deduplication:
     ```
     const getUser = cache(async (id: string) => {
       return db.user.findUnique({ where: { id } });
     });
     ```
  3. Parallel fetching: `const [user, posts] = await Promise.all([getUser(id), getPosts(id)])`
  4. Use Server Actions for mutations (forms, button clicks)
  5. Revalidate with `revalidatePath` or `revalidateTag` after mutations
  6. Use `unstable_cache` for cross-request caching (with tags for invalidation)
- **tools**: file_read, file_edit, grep
- **pitfalls**:
  - `fetch` in Server Components is auto-memoized in Next.js -- manual dedup may not be needed
  - `cache()` is request-scoped -- it does NOT cache across requests
  - Do NOT use `getServerSideProps` in App Router -- use Server Components instead
  - Server Actions are NOT GET requests -- do not use them for data fetching

### 7. Metadata and SEO in SSR
- **symptoms**:
  - Missing or incorrect meta tags in page source
  - Social media previews not working (Open Graph)
  - Search engines not indexing dynamic content
  - Duplicate title tags
  - Missing canonical URLs
- **causes**:
  - Using client-side `document.title` instead of framework metadata
  - Not using `generateMetadata` in App Router
  - Missing `Head` component in Pages Router
  - Dynamic OG images not configured
- **strategy**:
  1. App Router: export `metadata` or `generateMetadata` from page/layout:
     ```
     export async function generateMetadata({ params }) {
       const post = await getPost(params.id);
       return { title: post.title, description: post.excerpt };
     }
     ```
  2. Pages Router: use `next/head` in every page
  3. Configure OG images with `opengraph-image.tsx` or `generateImageMetadata`
  4. Use `robots.txt` and `sitemap.xml` (App Router: `app/robots.ts`, `app/sitemap.ts`)
  5. Add structured data (JSON-LD) in Server Components
- **tools**: file_read, file_edit, grep
- **pitfalls**:
  - `<title>` in client components does not affect SSR HTML -- crawlers may not see it
  - `generateMetadata` runs on the server -- do not use hooks or browser APIs in it
  - Test with `curl` or "View Source" to verify server-rendered HTML, not browser DevTools

## Tool Sequence
1. **grep** -- Search for hydration-related errors, `'use client'` directives, and SSR patterns
2. **file_read** -- Read the problematic component and its parent chain
3. **grep** -- Search for `window`, `document`, `localStorage`, `navigator` usage in render paths
4. **grep** -- Search for `useEffect`, `useLayoutEffect`, `useState` to understand client/server split
5. **file_read** -- Read Next.js config (`next.config.js`) and layout files
6. **file_edit** -- Apply SSR-safe fixes (useEffect wrapping, dynamic imports, use client directive)
7. **shell_exec** -- Run `next build` to verify no build errors
8. **shell_exec** -- Run `next dev` and check browser console for hydration warnings
9. **grep** -- Verify no remaining hydration mismatches in build output

## Validation Checklist
- [ ] No hydration mismatch warnings in browser console
- [ ] `next build` passes without errors
- [ ] Server-rendered HTML contains expected content (check with `curl` or View Source)
- [ ] Client-only components properly wrapped with `dynamic({ ssr: false })` or `useEffect`
- [ ] `'use client'` directives are at the lowest possible level
- [ ] No `useLayoutEffect` warnings on server
- [ ] SEO meta tags present in server-rendered HTML
- [ ] Page loads meaningfully without JavaScript (progressive enhancement)
- [ ] Streaming Suspense boundaries placed around slow content
- [ ] No unnecessary client-side data fetching that could be done on server
