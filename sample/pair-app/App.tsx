import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

// With `adb reverse tcp:8080 tcp:8080` the phone reaches the sample server on the computer as localhost.
const DEFAULT_SERVER = 'http://localhost:8080';
const NAME = 'Phone owner';

type Step = { at: 'enter' } | { at: 'confirm' } | { at: 'done' };

/** duetpair://pair?code=123456&server=<url>, what scanning the QR code on the computer would open. */
function parsePairLink(url: string | null): { code?: string; server?: string } | null {
  const m = url ? /^duetpair:\/\/pair\/?(?:\?(.*))?$/.exec(url) : null;
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? '');
  return { code: q.get('code') ?? undefined, server: q.get('server') ?? undefined };
}

export default function App() {
  const [step, setStep] = useState<Step>({ at: 'enter' });
  const [code, setCode] = useState('');
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const open = (url: string | null) => {
      const link = parsePairLink(url);
      if (!link) return;
      console.log('[duet-pair] opened from a pairing link');
      if (link.server) setServer(link.server);
      if (link.code) {
        setCode(link.code.replace(/\D/g, '').slice(0, 6));
        setStep({ at: 'confirm' });
      }
    };
    Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener('url', (e) => open(e.url));
    return () => sub.remove();
  }, []);

  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;

  async function approve() {
    setBusy(true);
    setError(null);
    console.log(`[duet-pair] approving code ${code}`);
    try {
      const res = await fetch(`${server}/api/pair/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: NAME }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
      console.log(`[duet-pair] approved code ${code}`);
      setStep({ at: 'done' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`[duet-pair] approval failed: ${message}`);
      setError(message === 'Network request failed' ? 'Could not reach the computer. Check the server address.' : message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCode('');
    setError(null);
    setStep({ at: 'enter' });
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.page}>
        <StatusBar style="dark" />
        {step.at === 'enter' && (
          <View style={styles.body}>
            <Text style={styles.title}>Sign in on a computer</Text>
            <Text style={styles.muted}>Enter the 6-digit code shown in the browser.</Text>
            <TextInput
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="000000"
              style={styles.code}
              accessibilityLabel="Code from the computer"
            />
            <Pressable
              style={[styles.primary, code.length !== 6 && styles.disabled]}
              disabled={code.length !== 6}
              onPress={() => setStep({ at: 'confirm' })}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>Continue</Text>
            </Pressable>
            <View style={styles.field}>
              <Text style={styles.label}>Computer address</Text>
              <TextInput value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="Computer address" />
            </View>
          </View>
        )}
        {step.at === 'confirm' && (
          <View style={styles.body}>
            <Text style={styles.title}>Sign in to this browser?</Text>
            <Text style={styles.muted}>
              The browser showing <Text style={styles.strong}>{pretty}</Text> will be signed in as {NAME}.
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable style={styles.primary} onPress={approve} disabled={busy} accessibilityRole="button">
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Approve</Text>}
            </Pressable>
            <Pressable style={styles.secondary} onPress={reset} accessibilityRole="button">
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        )}
        {step.at === 'done' && (
          <View style={styles.body}>
            <Text style={styles.title}>Approved</Text>
            <Text style={styles.muted}>The browser showing {pretty} is now signed in as {NAME}.</Text>
            <Pressable style={styles.secondary} onPress={reset} accessibilityRole="button">
              <Text style={styles.secondaryText}>Done</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const colors = { text: '#1d1d1f', muted: '#5f6368', line: '#e3e3e3', field: '#f4f4f4', primary: '#1d1d1f', error: '#b3261e' };

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 24, gap: 16 },
  title: { fontSize: 22, fontWeight: '600', color: colors.text },
  muted: { fontSize: 15, lineHeight: 22, color: colors.muted },
  strong: { fontWeight: '600', color: colors.text },
  code: { fontSize: 32, letterSpacing: 6, textAlign: 'center', paddingVertical: 14, borderRadius: 8, backgroundColor: colors.field, color: colors.text, fontVariant: ['tabular-nums'] },
  field: { gap: 6, marginTop: 16 },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  input: { fontSize: 15, backgroundColor: colors.field, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, color: colors.text },
  primary: { backgroundColor: colors.primary, borderRadius: 6, paddingVertical: 14, alignItems: 'center' },
  primaryText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  disabled: { opacity: 0.35 },
  secondary: { borderRadius: 6, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.line },
  secondaryText: { fontSize: 15, fontWeight: '600', color: colors.text },
  error: { fontSize: 14, color: colors.error },
});
