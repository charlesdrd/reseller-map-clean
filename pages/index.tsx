import { useEffect } from 'react';
export default function Home(){
  useEffect(()=>{
    const key = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('key') : '';
    if (typeof window !== 'undefined') {
      const k = key ? `?key=${encodeURIComponent(key)}` : '';
      window.location.href = `/map${k}`;
    }
  },[]);
  return null;
}
