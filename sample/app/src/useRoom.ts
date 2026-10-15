import { useEffect, useRef, useState } from 'react';

export interface Person {
  name: string;
  role: 'host' | 'viewer';
}

export type Connection = 'connecting' | 'open' | 'closed';

/**
 * Joins a room on the sample relay server as a viewer.
 * The host's shared screen arrives as JPEG frames (data URLs); people as a list.
 */
export function useRoom(server: string, room: string, name: string) {
  const [frame, setFrame] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url = `${server.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}&role=viewer&name=${encodeURIComponent(name)}`;
    const ws = new WebSocket(url);
    socket.current = ws;
    setConnection('connecting');
    ws.onopen = () => {
      console.log(`[duet-sample] joined ${room}`);
      setConnection('open');
    };
    ws.onclose = () => setConnection('closed');
    ws.onerror = () => setConnection('closed');
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; data?: string; people?: Person[] };
      if (msg.type === 'frame') setFrame(msg.data ?? null);
      else if (msg.type === 'stopped') setFrame(null);
      else if (msg.type === 'people') setPeople(msg.people ?? []);
    };
    return () => ws.close();
  }, [server, room, name]);

  return { frame, people, connection };
}
