import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { colors, type } from './theme';
import { useRoom, type Person } from './useRoom';

interface Props {
  server: string;
  room: string;
  onLeave(): void;
}

/** The room: the host's shared screen on a stage, and who is here. Two panes when the window is wide. */
export function Room({ server, room, onLeave }: Props) {
  const { frame, people, connection } = useRoom(server, room, 'Phone viewer');
  const { width } = useWindowDimensions();
  const twoPane = width >= 600;
  // Full screen lives here, not in Stage: turning the phone sideways switches to two panes,
  // which remounts Stage, and state kept inside it would be lost (full screen would close itself).
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    console.log(`[duet-sample] full screen ${fullScreen ? 'open' : 'closed'}`);
    ScreenOrientation.lockAsync(fullScreen ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, [fullScreen]);

  const stage = <Stage frame={frame} connection={connection} fullScreen={fullScreen} onFullScreen={setFullScreen} />;

  const header = (
    <View style={styles.header}>
      <Text style={type.title} numberOfLines={1}>
        {room}
      </Text>
      <Pressable onPress={onLeave} hitSlop={12} accessibilityRole="button">
        <Text style={type.link}>Leave</Text>
      </Pressable>
    </View>
  );

  if (twoPane) {
    return (
      <View style={styles.twoPane}>
        <View style={styles.main}>
          {header}
          {stage}
        </View>
        <View style={styles.side}>
          <People people={people} />
        </View>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.onePane}>
      {header}
      {stage}
      <People people={people} />
    </ScrollView>
  );
}

interface StageProps {
  frame: string | null;
  connection: string;
  fullScreen: boolean;
  onFullScreen(open: boolean): void;
}

function Stage({ frame, connection, fullScreen, onFullScreen: setFullScreen }: StageProps) {
  useEffect(() => {
    console.log('[duet-sample] stage mounted');
    return () => console.log('[duet-sample] stage unmounted');
  }, []);

  return (
    <View style={styles.stage}>
      {frame ? (
        <Image source={{ uri: frame }} style={styles.frame} resizeMode="contain" fadeDuration={0} accessibilityLabel="Shared screen" />
      ) : (
        <Text style={styles.waiting}>
          {connection === 'open'
            ? 'Waiting for the host to share a screen'
            : connection === 'connecting'
              ? 'Connecting'
              : 'Not connected to the room server'}
        </Text>
      )}
      {frame ? (
        <Pressable
          style={styles.expand}
          onPress={() => setFullScreen(true)}
          accessibilityRole="button"
          accessibilityLabel="Full screen"
          hitSlop={8}
        >
          <Text style={styles.expandText}>Full screen</Text>
        </Pressable>
      ) : null}
      <Modal
        visible={fullScreen}
        animationType="none"
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => setFullScreen(false)}
      >
        <StatusBar hidden />
        <View style={styles.full}>
          {frame ? (
            <Image
              source={{ uri: frame }}
              style={styles.frame}
              resizeMode="contain"
              fadeDuration={0}
              accessibilityLabel="Shared screen, full screen"
            />
          ) : null}
          <Pressable
            style={styles.close}
            onPress={() => setFullScreen(false)}
            accessibilityRole="button"
            accessibilityLabel="Exit full screen"
            hitSlop={8}
          >
            <Text style={styles.expandText}>Exit full screen</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

function People({ people }: { people: Person[] }) {
  return (
    <View style={styles.people}>
      <Text style={type.label}>In the room</Text>
      {people.length === 0 ? <Text style={type.muted}>Nobody else yet</Text> : null}
      {people.map((p, i) => (
        <View key={`${p.name}-${i}`} style={styles.person}>
          <Text style={type.body}>{p.name}</Text>
          <Text style={type.muted}>{p.role === 'host' ? 'Host' : 'Viewer'}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  onePane: { padding: 16, gap: 16 },
  twoPane: { flex: 1, flexDirection: 'row', padding: 16, gap: 24 },
  main: { flex: 2, gap: 16 },
  side: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  stage: {
    aspectRatio: 16 / 9,
    backgroundColor: colors.stage,
    borderRadius: 6,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: '100%', height: '100%' },
  waiting: { ...type.body, color: colors.onStageMuted, paddingHorizontal: 16, textAlign: 'center' },
  expand: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.overlay,
    borderRadius: 6,
  },
  expandText: { ...type.small, color: colors.onStage },
  full: { flex: 1, backgroundColor: colors.stage, alignItems: 'center', justifyContent: 'center' },
  close: {
    position: 'absolute',
    left: 16,
    top: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.overlay,
    borderRadius: 6,
  },
  people: { gap: 8 },
  person: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
});
