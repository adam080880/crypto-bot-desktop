import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function Placeholder({ title, phase, children }: { title: string; phase: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Belum tersedia</CardTitle>
          <CardDescription>Dibangun di {phase}.</CardDescription>
        </CardHeader>
        {children && <CardContent>{children}</CardContent>}
      </Card>
    </div>
  )
}
