import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Room } from './src/Room';
import { colors, type } from './src/theme';

// With `adb reverse tcp:8080 tcp:8080` the phone reaches the sample server on the computer as localhost.
const DEFAULT_SERVER = 'http://localhost:8080';

/** duetsample://room/<name>?server=<url> */
function parseRoomLink(url: string | null): { room: string; server?: string } | null {
  const m = url ? /^duetsample:\/\/room\/([^?#]+)(?:\?(.*))?/.exec(url) : null;
  if (!m) return null;
  const server = new URLSearchParams(m[2] ?? '').get('server') ?? undefined;
  return { room: decodeURIComponent(m[1]!), server };
}

export default function App() {
  const [joined, setJoined] = useState<{ room: string; server: string } | null>(null);
  const [room, setRoom] = useState('demo');
  const [server, setServer] = useState(DEFAULT_SERVER);

  useEffect(() => {
    const open = (url: string | null) => {
      const link = parseRoomLink(url);
      if (!link) return;
      console.log(`[duet-sample] link to room ${link.room}`);
      setRoom(link.room);
      if (link.server) setServer(link.server);
    };
    Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener('url', (e) => open(e.url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.page}>
        <StatusBar style="dark" />
        {joined ? (
          <Room server={joined.server} room={joined.room} onLeave={() => setJoined(null)} />
        ) : (
          <View style={styles.lobby}>
            <Text style={type.title}>Join a room</Text>
            <Text style={type.muted}>Watch the host's shared screen.</Text>
            <View style={styles.field}>
              <Text style={type.label}>Room</Text>
              <TextInput
                value={room}
                onChangeText={setRoom}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                accessibilityLabel="Room"
              />
            </View>
            <View style={styles.field}>
              <Text style={type.label}>Server</Text>
              <TextInput
                value={server}
                onChangeText={setServer}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
                accessibilityLabel="Server"
              />
            </View>
            <Pressable
              style={({ pressed }) => [styles.join, pressed && { opacity: 0.85 }]}
              onPress={() => setJoined({ room: room.trim() || 'demo', server: server.trim() || DEFAULT_SERVER })}
              accessibilityRole="button"
            >
              <Text style={styles.joinText}>Join {room.trim() || 'demo'}</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  lobby: { padding: 16, gap: 16 },
  field: { gap: 6 },
  input: { ...type.body, backgroundColor: colors.field, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10 },
  join: { backgroundColor: colors.primary, borderRadius: 6, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  joinText: { fontSize: 15, fontWeight: '600', color: colors.onPrimary },
});
