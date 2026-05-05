import { redirect } from 'next/navigation';

// Old /live route — kept as a redirect so any saved bookmarks still work.
export default function LiveRedirect() {
  redirect('/lives');
}
