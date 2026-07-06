import { createContext, useContext, useRef, useState, ReactNode } from 'react'
import { View, Text, Image, StyleSheet } from 'react-native'
import { captureRef } from 'react-native-view-shot'

export interface ShareCardContent {
  avatarUrl: string | null
  displayName: string
  kind: 'ac' | 'note'
  documentNumber?: string
  title: string
  subtitle?: string
}

interface ShareCardContextValue {
  capture: (content: ShareCardContent) => Promise<string>
}

const ShareCardContext = createContext<ShareCardContextValue | null>(null)

export function useShareCard() {
  const ctx = useContext(ShareCardContext)
  if (!ctx) throw new Error('useShareCard must be used within ShareCardProvider')
  return ctx
}

// Mounted once near the app root. Renders the card off-screen (never visible
// to the user), and captures it to a temporary PNG whenever `capture()` is
// called — that's the file handed to Share.share() so a receiver sees a
// single branded image with the sharer's photo baked in, regardless of which
// app they open the share in (native share sheets don't support attaching an
// avatar alongside a plain text message in any way we can rely on).
export function ShareCardProvider({ children }: { children: ReactNode }) {
  const viewRef = useRef<View>(null)
  const [content, setContent] = useState<ShareCardContent | null>(null)
  const resolveRef = useRef<((uri: string) => void) | null>(null)

  const capture = (next: ShareCardContent): Promise<string> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setContent(next)
      // Wait a frame for the off-screen card to actually render the new
      // content before shooting it — captureRef only sees what's painted.
      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          if (!viewRef.current) return
          try {
            const uri = await captureRef(viewRef, { format: 'png', quality: 0.95 })
            resolveRef.current?.(uri)
          } finally {
            resolveRef.current = null
            setContent(null)
          }
        })
      })
    })
  }

  return (
    <ShareCardContext.Provider value={{ capture }}>
      {children}
      <View style={styles.offscreen} pointerEvents="none">
        {content && (
          <View
            ref={viewRef}
            collapsable={false}
            style={[styles.card, { backgroundColor: '#07111E' }]}
          >
            <View style={styles.header}>
              {content.avatarUrl ? (
                <Image source={{ uri: content.avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarFallbackText}>{content.displayName.charAt(0).toUpperCase()}</Text>
                </View>
              )}
              <Text style={styles.sharedBy} numberOfLines={1}>{content.displayName} shared via FlyRegs</Text>
            </View>

            <View style={styles.body}>
              {content.documentNumber && <Text style={styles.docNumber}>{content.documentNumber}</Text>}
              <Text style={styles.title} numberOfLines={3}>{content.title}</Text>
              {content.subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{content.subtitle}</Text> : null}
            </View>

            <Image source={require('@/assets/images/flyregs-wing.png')} style={styles.wing} resizeMode="contain" />
          </View>
        )}
      </View>
    </ShareCardContext.Provider>
  )
}

const CARD_WIDTH = 600

const styles = StyleSheet.create({
  offscreen: { position: 'absolute', top: -10000, left: -10000 },
  card: {
    width: CARD_WIDTH,
    padding: 32,
    borderRadius: 24,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarFallback: { backgroundColor: '#4B8EF5', alignItems: 'center', justifyContent: 'center' },
  avatarFallbackText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  sharedBy: { color: 'rgba(255,255,255,0.7)', fontSize: 16, flex: 1 },
  body: { marginTop: 28, gap: 8 },
  docNumber: { color: '#4B8EF5', fontSize: 20, fontWeight: '800' },
  title: { color: '#fff', fontSize: 26, fontWeight: '700', lineHeight: 34 },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 16, lineHeight: 22, marginTop: 4 },
  wing: { width: 48, height: 53, alignSelf: 'flex-end', marginTop: 24 },
})
