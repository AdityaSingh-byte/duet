import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

// With `adb reverse tcp:8765 tcp:8765` the phone reaches the community sample server as localhost.
const SERVER = 'http://localhost:8765';
const ME = 'alex';

type User = { id: string; name: string };
type Post = { id: string; userId: string; author: string; title: string; body: string; at: number; comments: number };
type Comment = { id: string; userId: string; author: string; text: string; at: number };
type FullPost = Post & { commentList: Comment[] };

const log = (msg: string) => console.log(`[acme-community] ${msg}`);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

async function api<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, init && { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
  return body as T;
}

const reachError = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  return message === 'Network request failed' ? 'Could not reach the server. Check that it is running.' : message;
};

export default function App() {
  const [tab, setTab] = useState<'feed' | 'profile'>('feed');
  const [openPost, setOpenPost] = useState<string | null>(null);
  const [me, setMe] = useState<User | null>(null);

  useEffect(() => {
    api<User>(`/api/users/${ME}`)
      .then(setMe)
      .catch((e) => log(`could not load the profile: ${reachError(e)}`));
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Text style={styles.markText}>A</Text>
          </View>
          <Text style={styles.brandText}>Acme Community</Text>
        </View>
        <View style={styles.content}>
          {tab === 'feed' && !openPost && <Feed onOpen={setOpenPost} />}
          {tab === 'feed' && openPost && <PostScreen id={openPost} me={me} onBack={() => setOpenPost(null)} />}
          {tab === 'profile' && <Profile me={me} onSaved={setMe} />}
        </View>
        <View style={styles.tabs}>
          {(['feed', 'profile'] as const).map((t) => (
            <Pressable key={t} style={styles.tab} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
              <View style={[styles.tabLine, tab === t && styles.tabLineOn]} />
              <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t === 'feed' ? 'Feed' : 'Profile'}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Feed({ onOpen }: { onOpen: (id: string) => void }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Post[]>('/api/posts')
      .then(setPosts)
      .catch((e) => setError(reachError(e)));
  }, []);

  if (error) return <Text style={[styles.pad, styles.error]}>{error}</Text>;
  if (!posts) return <ActivityIndicator style={styles.loading} color={colors.muted} />;
  return (
    <ScrollView>
      {posts.map((p) => (
        <Pressable key={p.id} style={styles.feedRow} onPress={() => onOpen(p.id)} accessibilityRole="button">
          <Text style={styles.feedTitle}>{p.title}</Text>
          <Text style={styles.meta}>
            {p.author} · {ago(p.at)} · {p.comments === 1 ? '1 comment' : `${p.comments} comments`}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function PostScreen({ id, me, onBack }: { id: string; me: User | null; onBack: () => void }) {
  const [post, setPost] = useState<FullPost | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<FullPost>(`/api/posts/${id}`)
      .then((next) => {
        setPost((prev) => {
          const known = new Set(prev?.commentList.map((c) => c.id));
          if (prev) for (const c of next.commentList) if (!known.has(c.id) && c.userId !== ME) log(`new comment from ${c.author}: "${c.text}"`);
          return next;
        });
        setError(null);
      })
      .catch((e) => setError(reachError(e)));
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [load]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api<Comment>(`/api/posts/${id}/comments`, { method: 'POST', body: { user: ME, text } });
      log(`posted a comment: "${text}"`);
      setDraft('');
      Keyboard.dismiss();
      load();
    } catch (e) {
      setError(reachError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!post) return error ? <Text style={[styles.pad, styles.error]}>{error}</Text> : <ActivityIndicator style={styles.loading} color={colors.muted} />;
  // Your own comments show the name from your profile, so they read right as soon as you rename.
  const nameOf = (c: Comment) => (c.userId === ME && me ? me.name : c.author);

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} accessibilityRole="button" hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>Back</Text>
      </Pressable>
      <View style={styles.byline}>
        <Avatar name={post.author} />
        <Text style={styles.meta}>
          <Text style={styles.strong}>{post.author}</Text> · {ago(post.at)}
        </Text>
      </View>
      <Text style={styles.title}>{post.title}</Text>
      <Text style={styles.body}>{post.body}</Text>
      <Text style={styles.section}>
        Comments <Text style={styles.meta}>{post.commentList.length}</Text>
      </Text>
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Write a comment"
          placeholderTextColor={colors.faint}
          style={styles.input}
          accessibilityLabel="Write a comment"
          returnKeyType="send"
          onSubmitEditing={send}
        />
        <Pressable style={[styles.primarySmall, !draft.trim() && styles.disabled]} disabled={!draft.trim() || busy} onPress={send} accessibilityRole="button">
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Post</Text>}
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {post.commentList.map((c) => (
        <View key={c.id} style={styles.comment}>
          <Avatar name={nameOf(c)} />
          <View style={styles.commentText}>
            <Text style={styles.meta}>
              <Text style={styles.strong}>{nameOf(c)}</Text> · {ago(c.at)}
            </Text>
            <Text style={styles.body}>{c.text}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function Profile({ me, onSaved }: { me: User | null; onSaved: (u: User) => void }) {
  const [name, setName] = useState(me?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me) setName(me.name);
  }, [me]);

  if (!me) return <ActivityIndicator style={styles.loading} color={colors.muted} />;
  const changed = name.trim() !== '' && name.trim() !== me.name;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const user = await api<User>(`/api/users/${ME}`, { method: 'PATCH', body: { name: name.trim() } });
      log(`saved the display name: ${user.name}`);
      onSaved(user);
      setSaved(true);
      Keyboard.dismiss();
    } catch (e) {
      setError(reachError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.pad}>
      <View style={styles.profileHead}>
        <Avatar name={me.name} large />
        <View>
          <Text style={styles.feedTitle}>{me.name}</Text>
          <Text style={styles.meta}>Member since March</Text>
        </View>
      </View>
      <Text style={styles.label}>Your name</Text>
      <TextInput
        value={name}
        onChangeText={(t) => {
          setName(t);
          setSaved(false);
        }}
        selectTextOnFocus
        autoCorrect={false}
        style={[styles.input, styles.inputBlock]}
        accessibilityLabel="Display name"
      />
      <Text style={styles.hint}>Shown on your posts and comments.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.saveRow}>
        {saved ? <Text style={styles.saved}>Saved</Text> : null}
        <Pressable style={[styles.primarySmall, !changed && styles.disabled]} disabled={!changed || busy} onPress={save} accessibilityRole="button">
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Save</Text>}
        </Pressable>
      </View>
    </View>
  );
}

function Avatar({ name, large }: { name: string; large?: boolean }) {
  return (
    <View style={[styles.avatar, large && styles.avatarLarge]}>
      <Text style={[styles.avatarText, large && styles.avatarTextLarge]}>{initials(name)}</Text>
    </View>
  );
}

const colors = {
  text: '#18181b',
  muted: '#5f5f66',
  faint: '#8a8a92',
  line: '#e4e4e7',
  field: '#f4f4f5',
  avatar: '#e4e4e7',
  accent: '#2f5bd3',
  ok: '#15803d',
  error: '#b3261e',
};

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  mark: { width: 28, height: 28, borderRadius: 6, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  brandText: { fontSize: 18, fontWeight: '600', color: colors.text },
  content: { flex: 1 },
  pad: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  loading: { marginTop: 40 },
  feedRow: { paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.line, gap: 4 },
  feedTitle: { fontSize: 18, fontWeight: '600', color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  strong: { fontWeight: '600', color: colors.text },
  back: { alignSelf: 'flex-start', marginBottom: 12 },
  backText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  byline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, marginTop: 12, marginBottom: 6, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 23, color: colors.text },
  section: { fontSize: 16, fontWeight: '600', color: colors.text, marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.line },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, marginBottom: 4 },
  input: { flex: 1, fontSize: 16, backgroundColor: colors.field, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 11, color: colors.text },
  inputBlock: { flex: 0, alignSelf: 'stretch' },
  comment: { flexDirection: 'row', gap: 12, paddingVertical: 12 },
  commentText: { flex: 1, gap: 2 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.avatar, alignItems: 'center', justifyContent: 'center' },
  avatarLarge: { width: 64, height: 64, borderRadius: 32 },
  avatarText: { fontSize: 13, fontWeight: '600', color: '#3f3f46' },
  avatarTextLarge: { fontSize: 18 },
  profileHead: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 28 },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted, marginBottom: 6 },
  hint: { fontSize: 13, color: colors.muted, marginTop: 6 },
  saveRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 14, marginTop: 20 },
  saved: { fontSize: 16, color: colors.ok, fontWeight: '600' },
  primarySmall: { backgroundColor: colors.accent, borderRadius: 6, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center', minWidth: 76 },
  primaryText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  disabled: { opacity: 0.4 },
  error: { fontSize: 13, color: colors.error, marginTop: 6 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line },
  tab: { flex: 1, alignItems: 'center', paddingBottom: 14 },
  tabLine: { alignSelf: 'stretch', height: 2, marginBottom: 12 },
  tabLineOn: { backgroundColor: colors.accent },
  tabText: { fontSize: 16, fontWeight: '600', color: colors.muted },
  tabTextOn: { color: colors.accent },
});
