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
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Text style={styles.markText}>d</Text>
          </View>
          <Text style={styles.brandText}>duet pair</Text>
        </View>
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
              placeholderTextColor={colors.faint}
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
            <View style={styles.codeBox}>
              <Text style={styles.codeShown}>{pretty}</Text>
            </View>
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
            <View style={styles.check}>
              <View style={styles.tick} />
            </View>
            <Text style={[styles.title, styles.okTitle]}>Approved</Text>
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

const colors = {
  text: '#18181b',
  muted: '#52525b',
  faint: '#a1a1aa',
  line: '#e4e4e7',
  field: '#f4f4f5',
  accent: '#2f5bd3',
  accentTint: '#eef2fc',
  ok: '#15803d',
  error: '#b3261e',
};

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 8 },
  mark: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  brandText: { fontSize: 17, fontWeight: '600', color: colors.text },
  body: { paddingHorizontal: 24, paddingTop: 24, gap: 18 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  okTitle: { color: colors.ok },
  muted: { fontSize: 17, lineHeight: 25, color: colors.muted },
  strong: { fontWeight: '700', color: colors.text },
  code: {
    fontSize: 44,
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: colors.field,
    color: colors.text,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  codeBox: { backgroundColor: colors.accentTint, borderRadius: 14, paddingVertical: 22, alignItems: 'center' },
  codeShown: { fontSize: 44, fontWeight: '700', letterSpacing: 4, color: colors.accent, fontVariant: ['tabular-nums'] },
  field: { gap: 6, marginTop: 20 },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  input: { fontSize: 15, backgroundColor: colors.field, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: colors.muted },
  primary: { backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 18, alignItems: 'center' },
  primaryText: { fontSize: 18, fontWeight: '700', color: '#fff' },
  disabled: { opacity: 0.35 },
  secondary: { borderRadius: 14, paddingVertical: 18, alignItems: 'center', borderWidth: 1, borderColor: colors.line },
  secondaryText: { fontSize: 18, fontWeight: '600', color: colors.text },
  check: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.ok, alignItems: 'center', justifyContent: 'center' },
  tick: { width: 20, height: 36, borderRightWidth: 6, borderBottomWidth: 6, borderColor: '#fff', transform: [{ rotate: '45deg' }], marginTop: -8 },
  error: { fontSize: 15, color: colors.error },
});
